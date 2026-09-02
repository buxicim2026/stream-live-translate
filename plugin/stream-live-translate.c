/*
 * Stream Live Translate — OBS thin-shell plugin.
 *
 * Responsibilities:
 *   1. Launch (and later terminate) the bundled Rust engine that lives in
 *      this plugin's data directory (data/engine/stream-live-translate).
 *   2. Register the "Live Subtitle Capture" audio filter. The filter taps
 *      the audio of whatever OBS source it is attached to, mixes down to
 *      mono, and streams 16 kHz s16le PCM to the engine's local ingest TCP
 *      port (default 8788).
 *
 * Everything else (VAD / music detection, language detection, LLM, the
 * subtitle overlay and the admin panel) lives in the engine.
 */

#ifdef _WIN32
/* Must come before any windows.h (pulled in by libobs headers). */
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include <obs-module.h>
#include <media-io/audio-io.h>
#include <util/platform.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#pragma comment(lib, "ws2_32")
typedef SOCKET slt_sock_t;
#define SLT_INVALID_SOCK INVALID_SOCKET
#else
#include <pthread.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
typedef int slt_sock_t;
#define SLT_INVALID_SOCK (-1)
#endif

#define SLT_MODULE_NAME "stream-live-translate"
#define SLT_INGEST_PORT_DEFAULT 8788
#define SLT_INGEST_RATE 16000
#define SLT_RMS_GATE 0.0005f

/* OBS's util/threading.h unconditionally includes <pthread.h> (OBS builds
 * with pthreads on every platform), which breaks standalone MSVC builds of
 * this plugin. We only need the os_event API, which libobs exports, so
 * forward-declare it instead of including the header. */
struct os_event_data;
typedef struct os_event_data os_event_t;
enum os_event_type {
	OS_EVENT_TYPE_AUTO,
	OS_EVENT_TYPE_MANUAL,
};
extern int os_event_init(os_event_t **event, enum os_event_type type);
extern void os_event_destroy(os_event_t *event);
extern int os_event_timedwait(os_event_t *event, unsigned long milliseconds);
extern int os_event_try(os_event_t *event);
extern int os_event_signal(os_event_t *event);

/* OBS's util/threading.h does not expose a plain mutex type (only os_event /
 * os_sem), so wrap the native primitives directly. */
#ifdef _WIN32
typedef CRITICAL_SECTION slt_mutex_t;
#else
typedef pthread_mutex_t slt_mutex_t;
#endif

static void slt_mutex_init(slt_mutex_t *m)
{
#ifdef _WIN32
	InitializeCriticalSection(m);
#else
	pthread_mutex_init(m, NULL);
#endif
}

static void slt_mutex_destroy(slt_mutex_t *m)
{
#ifdef _WIN32
	DeleteCriticalSection(m);
#else
	pthread_mutex_destroy(m);
#endif
}

static void slt_mutex_lock(slt_mutex_t *m)
{
#ifdef _WIN32
	EnterCriticalSection(m);
#else
	pthread_mutex_lock(m);
#endif
}

static void slt_mutex_unlock(slt_mutex_t *m)
{
#ifdef _WIN32
	LeaveCriticalSection(m);
#else
	pthread_mutex_unlock(m);
#endif
}

/* ---------------------------------------------------------------------- */
/* Shared sender state                                                     */
/* ---------------------------------------------------------------------- */

/* Ring buffer of s16le mono PCM captured at the OBS audio output rate.
 * 2 MiB holds ~22 s at 48 kHz; overflow drops the newest data, which only
 * happens if the engine is unreachable for a long time anyway. */
#define SLT_RING_BYTES (2 * 1024 * 1024)

struct slt_sender {
	slt_mutex_t mutex;
	os_event_t *wake;
	os_event_t *stop;
	uint8_t *ring;
	size_t head; /* write position */
	size_t tail; /* read position  */
	size_t used;

	slt_sock_t sock;
	uint32_t port;
	volatile bool reconnect_requested;
	uint32_t in_rate;       /* sample rate the ring is filled at */
	double resample_pos;    /* fractional linear-resampler state */
	bool header_sent;

#ifdef _WIN32
	HANDLE engine_proc;
	HANDLE job;
	WSADATA wsa;
#else
	pid_t engine_pid;
#endif
};

static struct slt_sender g_sender;
static volatile bool g_sender_started = false;
#ifdef _WIN32
static HANDLE g_thread;
#else
static pthread_t g_thread;
#endif

/* ---------------------------------------------------------------------- */
/* Ring buffer helpers (caller holds g_sender.mutex)                       */
/* ---------------------------------------------------------------------- */

static void ring_push(const uint8_t *data, size_t len)
{
	if (len == 0)
		return;
	if (len > SLT_RING_BYTES - g_sender.used) {
		/* Engine is not draining; drop instead of building latency. */
		return;
	}
	size_t first = SLT_RING_BYTES - g_sender.head;
	if (first > len)
		first = len;
	memcpy(g_sender.ring + g_sender.head, data, first);
	if (len > first)
		memcpy(g_sender.ring, data + first, len - first);
	g_sender.head = (g_sender.head + len) % SLT_RING_BYTES;
	g_sender.used += len;
}

static size_t ring_pop(uint8_t *out, size_t max_len)
{
	size_t len = g_sender.used < max_len ? g_sender.used : max_len;
	if (len == 0)
		return 0;
	size_t first = SLT_RING_BYTES - g_sender.tail;
	if (first > len)
		first = len;
	memcpy(out, g_sender.ring + g_sender.tail, first);
	if (len > first)
		memcpy(out + first, g_sender.ring, len - first);
	g_sender.tail = (g_sender.tail + len) % SLT_RING_BYTES;
	g_sender.used -= len;
	return len;
}

/* ---------------------------------------------------------------------- */
/* Portable TCP helper                                                     */
/* ---------------------------------------------------------------------- */

static slt_sock_t slt_connect(uint16_t port)
{
	slt_sock_t s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (s == SLT_INVALID_SOCK)
		return SLT_INVALID_SOCK;

#ifndef _WIN32
#ifdef SO_NOSIGPIPE
	/* macOS / BSD sockets have no MSG_NOSIGNAL; instead disable SIGPIPE
	 * per-socket so a broken connection can't kill the plugin process. */
	int nosig = 1;
	setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &nosig, sizeof(nosig));
#endif
#endif

	struct sockaddr_in addr;
	memset(&addr, 0, sizeof(addr));
	addr.sin_family = AF_INET;
	addr.sin_port = htons(port);
	addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

	if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
#ifdef _WIN32
		closesocket(s);
#else
		close(s);
#endif
		return SLT_INVALID_SOCK;
	}

	int one = 1;
	setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one,
		   sizeof(one));
	return s;
}

static void slt_close(slt_sock_t s)
{
	if (s == SLT_INVALID_SOCK)
		return;
#ifdef _WIN32
	closesocket(s);
#else
	close(s);
#endif
}

static bool slt_send_all(slt_sock_t s, const uint8_t *buf, size_t len)
{
	size_t off = 0;
	while (off < len) {
#ifdef _WIN32
		int n = send(s, (const char *)buf + off, (int)(len - off), 0);
#else
		/* MSG_NOSIGNAL is a Linux/glibc extension and is undefined on
		 * macOS / BSD; there we rely on SO_NOSIGPIPE (set in
		 * slt_connect) to avoid SIGPIPE. */
#ifdef MSG_NOSIGNAL
		ssize_t n = send(s, buf + off, len - off, MSG_NOSIGNAL);
#else
		ssize_t n = send(s, buf + off, len - off, 0);
#endif
#endif
		if (n <= 0)
			return false;
		off += (size_t)n;
	}
	return true;
}

/* ---------------------------------------------------------------------- */
/* Engine process management                                               */
/* ---------------------------------------------------------------------- */

static bool engine_already_running(uint16_t port)
{
	slt_sock_t s = slt_connect(port);
	if (s == SLT_INVALID_SOCK)
		return false;
	slt_close(s);
	return true;
}

static void engine_spawn(void)
{
#ifdef _WIN32
	const char *exe = obs_module_file("engine/stream-live-translate.exe");
#else
	const char *exe = obs_module_file("engine/stream-live-translate");
#endif
	if (!exe) {
		blog(LOG_WARNING, "[SLT] bundled engine binary not found");
		return;
	}

	if (engine_already_running(SLT_INGEST_PORT_DEFAULT)) {
		blog(LOG_INFO,
		     "[SLT] engine already running, not spawning a second one");
		bfree((void *)exe);
		return;
	}

	char exe_copy[1024];
	snprintf(exe_copy, sizeof(exe_copy), "%s", exe);

#ifdef _WIN32
	char cmdline[2048];
	snprintf(cmdline, sizeof(cmdline), "\"%s\" --audio-mode obs_filter",
		 exe_copy);

	/* Run the engine from its own directory and capture its console
	 * output into engine.log next to the binary: the engine has no
	 * console window, so without this a startup crash would be
	 * completely silent. */
	char exedir[1024];
	snprintf(exedir, sizeof(exedir), "%s", exe_copy);
	char *sl = strrchr(exedir, '\\');
	if (!sl)
		sl = strrchr(exedir, '/');
	if (sl)
		*sl = '\0';

	char logpath[1200];
	snprintf(logpath, sizeof(logpath), "%s\\engine.log", exedir);

	SECURITY_ATTRIBUTES sa;
	memset(&sa, 0, sizeof(sa));
	sa.nLength = sizeof(sa);
	sa.bInheritHandle = TRUE;
	HANDLE logfile = CreateFileA(logpath, GENERIC_WRITE, FILE_SHARE_READ,
				     &sa, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
				     NULL);

	STARTUPINFOA si;
	PROCESS_INFORMATION pi;
	memset(&si, 0, sizeof(si));
	si.cb = sizeof(si);
	memset(&pi, 0, sizeof(pi));
	if (logfile != INVALID_HANDLE_VALUE) {
		si.dwFlags = STARTF_USESTDHANDLES;
		si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
		si.hStdOutput = logfile;
		si.hStdError = logfile;
	}

	if (!CreateProcessA(NULL, cmdline, NULL, NULL, TRUE, CREATE_NO_WINDOW,
			    NULL, exedir, &si, &pi)) {
		blog(LOG_WARNING, "[SLT] failed to spawn engine (err %lu)",
		     GetLastError());
		if (logfile != INVALID_HANDLE_VALUE)
			CloseHandle(logfile);
		bfree((void *)exe);
		return;
	}
	if (logfile != INVALID_HANDLE_VALUE)
		CloseHandle(logfile);
	CloseHandle(pi.hThread);
	g_sender.engine_proc = pi.hProcess;

	/* Kill the engine automatically if OBS crashes or is killed. */
	g_sender.job = CreateJobObjectA(NULL, NULL);
	if (g_sender.job) {
		JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
		memset(&info, 0, sizeof(info));
		info.BasicLimitInformation.LimitFlags =
			JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
		SetInformationJobObject(g_sender.job,
					JobObjectExtendedLimitInformation,
					&info, sizeof(info));
		AssignProcessToJobObject(g_sender.job, pi.hProcess);
	}

	blog(LOG_INFO, "[SLT] engine spawned (pid %lu)",
	     GetProcessId(pi.hProcess));
#else
	pid_t pid = fork();
	if (pid < 0) {
		blog(LOG_WARNING, "[SLT] fork failed: %s", strerror(errno));
		bfree((void *)exe);
		return;
	}
	if (pid == 0) {
		setsid();
		execl(exe_copy, exe_copy, "--audio-mode", "obs_filter",
		      (char *)NULL);
		_exit(127);
	}
	g_sender.engine_pid = pid;
	blog(LOG_INFO, "[SLT] engine spawned (pid %d)", (int)pid);
#endif

	bfree((void *)exe);
}

static void engine_terminate(void)
{
#ifdef _WIN32
	if (g_sender.engine_proc) {
		TerminateProcess(g_sender.engine_proc, 0);
		CloseHandle(g_sender.engine_proc);
		g_sender.engine_proc = NULL;
	}
	if (g_sender.job) {
		CloseHandle(g_sender.job); /* kills remaining job members */
		g_sender.job = NULL;
	}
#else
	if (g_sender.engine_pid > 0) {
		kill(g_sender.engine_pid, SIGTERM);
		g_sender.engine_pid = -1;
	}
#endif
}

static bool engine_alive(void)
{
#ifdef _WIN32
	if (!g_sender.engine_proc)
		return false;
	return WaitForSingleObject(g_sender.engine_proc, 0) == WAIT_TIMEOUT;
#else
	if (g_sender.engine_pid <= 0)
		return false;
	int st;
	pid_t r = waitpid(g_sender.engine_pid, &st, WNOHANG);
	if (r == 0)
		return true; /* still running */
	g_sender.engine_pid = -1; /* exited and reaped */
	return false;
#endif
}

/* Called periodically from the sender thread: if the engine died (e.g.
 * crashed at startup), respawn it instead of silently streaming nowhere. */
static void engine_ensure_running(void)
{
#ifdef _WIN32
	static DWORD last_try = 0;
	DWORD now = GetTickCount();
#else
	static time_t last_try = 0;
	time_t now = time(NULL);
#endif
	if (engine_alive())
		return;
#ifdef _WIN32
	if (now - last_try < 10000)
		return;
	last_try = now;
	if (g_sender.engine_proc) {
		CloseHandle(g_sender.engine_proc);
		g_sender.engine_proc = NULL;
	}
#else
	if (now - last_try < 10)
		return;
	last_try = now;
#endif
	blog(LOG_WARNING, "[SLT] engine is not running; (re)spawning it");
	engine_spawn();
}

/* ---------------------------------------------------------------------- */
/* Resampler (linear, persistent fractional position)                      */
/* ---------------------------------------------------------------------- */

static size_t resample_and_send(const int16_t *in, size_t n)
{
	int16_t out[4096];
	size_t produced = 0;

	if (g_sender.in_rate == SLT_INGEST_RATE) {
		if (!slt_send_all(g_sender.sock, (const uint8_t *)in,
				  n * sizeof(int16_t)))
			return 0;
		g_sender.resample_pos = 0;
		return n;
	}

	const double step = (double)g_sender.in_rate / SLT_INGEST_RATE;
	double pos = g_sender.resample_pos;

	while (pos + 1.0 < (double)n) {
		size_t i0 = (size_t)pos;
		double t = pos - (double)i0;
		double v = (1.0 - t) * in[i0] + t * in[i0 + 1];
		if (v > 32767.0)
			v = 32767.0;
		if (v < -32768.0)
			v = -32768.0;
		out[produced++] = (int16_t)v;
		pos += step;

		if (produced == 4096) {
			if (!slt_send_all(g_sender.sock,
					  (const uint8_t *)out,
					  produced * sizeof(int16_t)))
				return 0;
			produced = 0;
		}
	}
	if (produced > 0) {
		if (!slt_send_all(g_sender.sock, (const uint8_t *)out,
				  produced * sizeof(int16_t)))
			return 0;
	}

	g_sender.resample_pos = pos - (double)n;
	if (g_sender.resample_pos < 0)
		g_sender.resample_pos = 0;
	return n;
}

/* ---------------------------------------------------------------------- */
/* Sender thread                                                           */
/* ---------------------------------------------------------------------- */

static void sender_loop(void)
{
	uint8_t *chunk = bmalloc(16 * 1024);

	for (;;) {
		if (os_event_try(g_sender.stop) == 0)
			break;

		engine_ensure_running();

		/* Filter settings asked for a reconnect (port change). */
		if (g_sender.reconnect_requested &&
		    g_sender.sock != SLT_INVALID_SOCK) {
			slt_close(g_sender.sock);
			g_sender.sock = SLT_INVALID_SOCK;
		}
		g_sender.reconnect_requested = false;

		/* Ensure we are connected to the engine ingest port. */
		if (g_sender.sock == SLT_INVALID_SOCK) {
			g_sender.sock = slt_connect((uint16_t)g_sender.port);
			if (g_sender.sock != SLT_INVALID_SOCK) {
				uint8_t header[12];
				memcpy(header, "SLTA", 4);
				uint32_t rate = SLT_INGEST_RATE;
				uint32_t fmt = 0; /* mono s16le */
				memcpy(header + 4, &rate, 4);
				memcpy(header + 8, &fmt, 4);
				if (!slt_send_all(g_sender.sock, header,
						  sizeof(header))) {
					slt_close(g_sender.sock);
					g_sender.sock = SLT_INVALID_SOCK;
				} else {
					g_sender.header_sent = true;
					g_sender.resample_pos = 0;
					blog(LOG_INFO,
					     "[SLT] connected to engine ingest port %u",
					     g_sender.port);
				}
			}
		}

		/* Wait for audio (or reconnect timeout). */
		os_event_timedwait(g_sender.wake, 500);

		if (g_sender.sock == SLT_INVALID_SOCK)
			continue;

		/* Drain the ring buffer and stream it out. */
		for (;;) {
			size_t len;
			slt_mutex_lock(&g_sender.mutex);
			len = ring_pop(chunk, 16 * 1024);
			slt_mutex_unlock(&g_sender.mutex);
			if (len == 0)
				break;
			/* Drop a stray trailing byte (should not happen). */
			size_t samples = len / 2;
			if (samples > 0 &&
			    resample_and_send((const int16_t *)chunk,
					      samples) == 0) {
				blog(LOG_WARNING,
				     "[SLT] ingest send failed, reconnecting");
				slt_close(g_sender.sock);
				g_sender.sock = SLT_INVALID_SOCK;
				break;
			}
		}
	}

	bfree(chunk);
	slt_close(g_sender.sock);
	g_sender.sock = SLT_INVALID_SOCK;
}

#ifdef _WIN32
static DWORD WINAPI sender_thread(LPVOID param)
{
	UNUSED_PARAMETER(param);
	sender_loop();
	return 0;
}
#else
static void *sender_thread(void *param)
{
	UNUSED_PARAMETER(param);
	sender_loop();
	return NULL;
}
#endif

/* ---------------------------------------------------------------------- */
/* Audio filter                                                            */
/* ---------------------------------------------------------------------- */

struct slt_filter {
	obs_source_t *source;
	bool enabled;
	bool gate_silence;
	uint32_t port;
};

static const char *filter_get_name(void *unused)
{
	UNUSED_PARAMETER(unused);
	return obs_module_text("Filter");
}

static void filter_defaults(obs_data_t *s)
{
	obs_data_set_default_bool(s, "enabled", true);
	obs_data_set_default_bool(s, "gate_silence", false);
	obs_data_set_default_int(s, "port", SLT_INGEST_PORT_DEFAULT);
}

static obs_properties_t *filter_properties(void *unused)
{
	UNUSED_PARAMETER(unused);
	obs_properties_t *p = obs_properties_create();
	obs_properties_add_bool(p, "enabled", obs_module_text("Enabled"));
	obs_properties_add_bool(p, "gate_silence",
				obs_module_text("GateSilence"));
	obs_properties_add_int(p, "port", obs_module_text("Port"), 1024,
			       65535, 1);
	return p;
}

static void *filter_create(obs_data_t *settings, obs_source_t *source)
{
	struct slt_filter *f = bzalloc(sizeof(*f));
	f->source = source;
	f->enabled = obs_data_get_bool(settings, "enabled");
	f->gate_silence = obs_data_get_bool(settings, "gate_silence");
	f->port = (uint32_t)obs_data_get_int(settings, "port");

	if ((uint32_t)obs_data_get_int(settings, "port") != g_sender.port) {
		g_sender.port = (uint32_t)obs_data_get_int(settings, "port");
		g_sender.reconnect_requested = true;
	}
	blog(LOG_INFO, "[SLT] filter attached to source \"%s\"",
	     obs_source_get_name(source));
	return f;
}

static void filter_destroy(void *data)
{
	struct slt_filter *f = data;
	bfree(f);
}

static void filter_update(void *data, obs_data_t *settings)
{
	struct slt_filter *f = data;
	f->enabled = obs_data_get_bool(settings, "enabled");
	f->gate_silence = obs_data_get_bool(settings, "gate_silence");
	uint32_t port = (uint32_t)obs_data_get_int(settings, "port");
	if (port != g_sender.port) {
		g_sender.port = port;
		slt_mutex_lock(&g_sender.mutex);
		g_sender.head = g_sender.tail = g_sender.used = 0;
		slt_mutex_unlock(&g_sender.mutex);
		g_sender.reconnect_requested = true;
	}
}

static struct obs_audio_data *filter_audio(void *data,
					   struct obs_audio_data *audio)
{
	struct slt_filter *f = data;
	if (!f->enabled || !audio || audio->frames == 0)
		return audio;

	const uint32_t frames = audio->frames;
	/* struct obs_audio_data has no channel-layout field; derive the channel
	 * count from the active audio output configuration instead. */
	const struct audio_output_info *aoi =
		audio_output_get_info(obs_get_audio());
	const size_t channels = aoi ? get_audio_channels(aoi->speakers) : 0;
	if (channels == 0) {
		/* OBS audio output not ready yet; skip this frame silently. */
		return audio;
	}
	if (channels > MAX_AV_PLANES) {
		blog(LOG_WARNING,
		     "[SLT] unsupported channel count %zu (max %d)",
		     channels, MAX_AV_PLANES);
		return audio;
	}

	/* OBS audio filters receive planar float samples. */
	const float *planes[MAX_AV_PLANES];
	for (size_t c = 0; c < channels; c++) {
		planes[c] = (const float *)audio->data[c];
		if (!planes[c])
			return audio;
	}

	const float inv_ch = 1.0f / (float)channels;
	int16_t *mono = bmalloc(frames * sizeof(int16_t));
	double sq_sum = 0.0;

	for (uint32_t i = 0; i < frames; i++) {
		float acc = 0.0f;
		for (size_t c = 0; c < channels; c++)
			acc += planes[c][i];
		float v = acc * inv_ch;
		sq_sum += (double)v * v;
		if (v > 1.0f)
			v = 1.0f;
		else if (v < -1.0f)
			v = -1.0f;
		mono[i] = (int16_t)(v * 32767.0f);
	}

	const float rms = (float)sqrt(sq_sum / frames);
	if (!f->gate_silence || rms >= SLT_RMS_GATE) {
		const uint32_t rate =
			audio_output_get_sample_rate(obs_get_audio());
		slt_mutex_lock(&g_sender.mutex);
		if (rate != g_sender.in_rate) {
			/* Sample rate changed: restart resampler state. */
			g_sender.in_rate = rate ? rate : 48000;
			g_sender.resample_pos = 0;
			g_sender.head = g_sender.tail = g_sender.used = 0;
			blog(LOG_INFO,
			     "[SLT] audio sample rate set to %u",
			     g_sender.in_rate);
		}
		ring_push((const uint8_t *)mono, frames * sizeof(int16_t));
		slt_mutex_unlock(&g_sender.mutex);
		os_event_signal(g_sender.wake);
	}

	bfree(mono);
	return audio;
}

static struct obs_source_info filter_info = {
	.id = "stream_live_translate_capture",
	.type = OBS_SOURCE_TYPE_FILTER,
	.output_flags = OBS_SOURCE_AUDIO,
	.get_name = filter_get_name,
	.create = filter_create,
	.destroy = filter_destroy,
	.get_defaults = filter_defaults,
	.get_properties = filter_properties,
	.update = filter_update,
	.filter_audio = filter_audio,
};

/* ---------------------------------------------------------------------- */
/* Module lifecycle                                                        */
/* ---------------------------------------------------------------------- */

bool obs_module_load(void)
{
#ifdef _WIN32
	if (WSAStartup(MAKEWORD(2, 2), &g_sender.wsa) != 0)
		return false;
#endif

	g_sender.ring = bmalloc(SLT_RING_BYTES);
	g_sender.head = g_sender.tail = g_sender.used = 0;
	g_sender.sock = SLT_INVALID_SOCK;
	g_sender.port = SLT_INGEST_PORT_DEFAULT;
	g_sender.in_rate = 48000;
	g_sender.resample_pos = 0;
#ifndef _WIN32
	g_sender.engine_pid = -1;
#endif

	slt_mutex_init(&g_sender.mutex);
	os_event_init(&g_sender.wake, OS_EVENT_TYPE_AUTO);
	os_event_init(&g_sender.stop, OS_EVENT_TYPE_MANUAL);

	engine_spawn();

#ifdef _WIN32
	g_thread = CreateThread(NULL, 0, sender_thread, NULL, 0, NULL);
	g_sender_started = g_thread != NULL;
#else
	g_sender_started =
		pthread_create(&g_thread, NULL, sender_thread, NULL) == 0;
#endif

	obs_register_source(&filter_info);
	blog(LOG_INFO, "[SLT] Stream Live Translate plugin loaded (v0.0.6.1)");
	return true;
}

void obs_module_unload(void)
{
	if (g_sender_started) {
		os_event_signal(g_sender.stop);
#ifdef _WIN32
		WaitForSingleObject(g_thread, 3000);
		CloseHandle(g_thread);
#else
		pthread_join(g_thread, NULL);
#endif
		g_sender_started = false;
	}

	engine_terminate();

	os_event_destroy(g_sender.stop);
	os_event_destroy(g_sender.wake);
	slt_mutex_destroy(&g_sender.mutex);
	bfree(g_sender.ring);
	g_sender.ring = NULL;

#ifdef _WIN32
	WSACleanup();
#endif
}

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(SLT_MODULE_NAME, "en-US")