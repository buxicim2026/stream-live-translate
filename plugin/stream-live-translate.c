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
 *
 * --- OBS 30+ version compatibility -------------------------------------
 * This DLL is deliberately NOT tied to one OBS release:
 *
 *   * Source registration uses obs_register_source_s(info, size). libobs
 *     allocates a struct obs_source_info of its OWN size, copies only
 *     `size` bytes from the plugin, and zero-fills the remainder. That is
 *     libobs' official ABI-compatibility mechanism: a plugin compiled
 *     against older headers works on newer OBS (new callbacks are simply
 *     NULL), and vice versa (extra fields are ignored). Since OBS 30 the
 *     leading fields of obs_source_info have only ever been appended to.
 *   * obs_module_ver() is only required to exist; libobs does not compare
 *     it against LIBOBS_API_VER when loading a module.
 *   * No libobs threading API is used: the sender uses native events so
 *     there is no hand-written (and version-sensitive) forward declaration.
 *
 * In other words: build once against ANY OBS 30+ headers, run on OBS 30,
 * 31, 32, 33 and later. The import library must still be generated from
 * the actual installed obs.dll (see scripts/package-plugin.*).
 */

#ifdef _WIN32
/* Must come before any windows.h (pulled in by libobs headers). */
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

#include <obs-module.h>
#include <media-io/audio-io.h>
#include <util/platform.h>

#include <stdbool.h>
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
#include <sys/time.h>
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

/* 2 MiB holds ~22 s at 48 kHz; overflow drops the newest data, which only
 * happens if the engine is unreachable for a long time anyway. */
#define SLT_RING_BYTES (2 * 1024 * 1024)

/* Never malloc on the OBS real-time audio thread: downmix in fixed-size
 * stack chunks instead. */
#define SLT_MONO_CHUNK 1024

/* A stalled engine must not be able to block obs_module_unload() forever. */
#define SLT_SEND_TIMEOUT_MS 300
#define SLT_RECONNECT_WAIT_MS 500

/* ---------------------------------------------------------------------- */
/* Native mutex (libobs does not expose a plain mutex type)                */
/* ---------------------------------------------------------------------- */

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
/* Native wake / stop events                                               */
/*                                                                         */
/* Replaces libobs' os_event API. util/threading.h unconditionally         */
/* includes <pthread.h>, which breaks standalone MSVC builds; forward-     */
/* declaring those functions by hand instead ties the DLL to one libobs    */
/* ABI. Native primitives solve both problems and let unload() interrupt   */
/* the sender thread deterministically.                                    */
/* ---------------------------------------------------------------------- */

#ifdef _WIN32
typedef struct {
	HANDLE wake; /* auto-reset   */
	HANDLE stop; /* manual-reset */
} slt_events_t;
#else
typedef struct {
	pthread_mutex_t mutex;
	pthread_cond_t cond;
	bool wake;
	bool stop;
} slt_events_t;
#endif

static bool slt_events_init(slt_events_t *e)
{
	memset(e, 0, sizeof(*e));
#ifdef _WIN32
	e->wake = CreateEventA(NULL, FALSE, FALSE, NULL);
	e->stop = CreateEventA(NULL, TRUE, FALSE, NULL);
	if (!e->wake || !e->stop) {
		if (e->wake)
			CloseHandle(e->wake);
		if (e->stop)
			CloseHandle(e->stop);
		memset(e, 0, sizeof(*e));
		return false;
	}
	return true;
#else
	if (pthread_mutex_init(&e->mutex, NULL) != 0)
		return false;
	if (pthread_cond_init(&e->cond, NULL) != 0) {
		pthread_mutex_destroy(&e->mutex);
		return false;
	}
	return true;
#endif
}

static void slt_events_destroy(slt_events_t *e)
{
#ifdef _WIN32
	if (e->wake)
		CloseHandle(e->wake);
	if (e->stop)
		CloseHandle(e->stop);
#else
	pthread_cond_destroy(&e->cond);
	pthread_mutex_destroy(&e->mutex);
#endif
	memset(e, 0, sizeof(*e));
}

static void slt_events_signal(slt_events_t *e)
{
#ifdef _WIN32
	if (e->wake)
		SetEvent(e->wake);
#else
	pthread_mutex_lock(&e->mutex);
	e->wake = true;
	pthread_cond_broadcast(&e->cond);
	pthread_mutex_unlock(&e->mutex);
#endif
}

static void slt_events_stop(slt_events_t *e)
{
#ifdef _WIN32
	if (e->stop)
		SetEvent(e->stop);
#else
	pthread_mutex_lock(&e->mutex);
	e->stop = true;
	pthread_cond_broadcast(&e->cond);
	pthread_mutex_unlock(&e->mutex);
#endif
}

static bool slt_events_is_stopped(slt_events_t *e)
{
#ifdef _WIN32
	return e->stop && WaitForSingleObject(e->stop, 0) == WAIT_OBJECT_0;
#else
	bool stopped;
	pthread_mutex_lock(&e->mutex);
	stopped = e->stop;
	pthread_mutex_unlock(&e->mutex);
	return stopped;
#endif
}

/* Returns true when stop was signalled, false on wake or timeout. */
static bool slt_events_wait(slt_events_t *e, unsigned long ms)
{
#ifdef _WIN32
	HANDLE handles[2] = {e->wake, e->stop};
	DWORD r = WaitForMultipleObjects(2, handles, FALSE, (DWORD)ms);
	return r == WAIT_OBJECT_0 + 1;
#else
	struct timespec ts;
	int rc = 0;
	bool stopped;

	clock_gettime(CLOCK_REALTIME, &ts);
	ts.tv_sec += (time_t)(ms / 1000);
	ts.tv_nsec += (long)(ms % 1000) * 1000000L;
	if (ts.tv_nsec >= 1000000000L) {
		ts.tv_sec += 1;
		ts.tv_nsec -= 1000000000L;
	}

	pthread_mutex_lock(&e->mutex);
	while (!e->stop && !e->wake && rc != ETIMEDOUT)
		rc = pthread_cond_timedwait(&e->cond, &e->mutex, &ts);
	e->wake = false;
	stopped = e->stop;
	pthread_mutex_unlock(&e->mutex);
	return stopped;
#endif
}

/* ---------------------------------------------------------------------- */
/* Shared sender state                                                     */
/* ---------------------------------------------------------------------- */

struct slt_sender {
	/* guards ring / in_rate / resample_pos / port / reconnect_requested */
	slt_mutex_t mutex;
	slt_events_t events;
	uint8_t *ring;
	size_t head; /* write position */
	size_t tail; /* read position  */
	size_t used;

	/* owned exclusively by the sender thread */
	slt_sock_t sock;
	bool header_sent;

	uint32_t port;
	bool reconnect_requested;
	uint32_t in_rate;    /* sample rate the ring is filled at */
	double resample_pos; /* fractional linear-resampler state */
	bool external_engine;/* engine was started outside this plugin */

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
/* Set once by obs_module_unload(); read by the audio thread and sender. */
static volatile bool g_stopping = false;
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
	if (len == 0 || len > SLT_RING_BYTES)
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

	/* A bounded send timeout is essential. Without it a stalled engine
	 * can block send() indefinitely, and obs_module_unload() would then
	 * free the mutex/ring/WSA out from under the still-running sender
	 * (a use-after-free inside the OBS process). */
#ifdef _WIN32
	DWORD send_to = SLT_SEND_TIMEOUT_MS;
	setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char *)&send_to,
		   sizeof(send_to));
#else
	struct timeval send_to;
	send_to.tv_sec = 0;
	send_to.tv_usec = SLT_SEND_TIMEOUT_MS * 1000;
	setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &send_to, sizeof(send_to));
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
		int n;
#else
		ssize_t n;
#endif
		if (g_stopping)
			return false;
#ifdef _WIN32
		n = send(s, (const char *)buf + off, (int)(len - off), 0);
#else
		/* MSG_NOSIGNAL is a Linux/glibc extension and is undefined on
		 * macOS / BSD; there we rely on SO_NOSIGPIPE (set in
		 * slt_connect) to avoid SIGPIPE. */
#ifdef MSG_NOSIGNAL
		n = send(s, buf + off, len - off, MSG_NOSIGNAL);
#else
		n = send(s, buf + off, len - off, 0);
#endif
#endif
		if (n < 0) {
#ifdef _WIN32
			if (WSAGetLastError() == WSAEINTR)
				continue;
#else
			if (errno == EINTR)
				continue;
#endif
			return false;
		}
		if (n == 0)
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
		/* Standalone engine / another OBS instance owns the port.
		 * Remember that so engine_ensure_running() does not retry a
		 * spawn (and an extra ingest connection) every 10 seconds. */
		g_sender.external_engine = true;
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

	g_sender.external_engine = false;
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
#else
	if (now - last_try < 10)
		return;
#endif
	last_try = now;

	if (g_sender.external_engine) {
		/* Still owned by someone else? Then leave it alone. If the
		 * port went away we take over and spawn our own engine. */
		if (engine_already_running(SLT_INGEST_PORT_DEFAULT))
			return;
		g_sender.external_engine = false;
	}

#ifdef _WIN32
	if (g_sender.engine_proc) {
		CloseHandle(g_sender.engine_proc);
		g_sender.engine_proc = NULL;
	}
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
	uint32_t in_rate;
	double pos;
	bool ok = true;

	/* Snapshot the shared resampler state under the same lock the audio
	 * callback uses. Reading/writing a double from two threads without
	 * synchronisation is undefined behaviour in C. */
	slt_mutex_lock(&g_sender.mutex);
	in_rate = g_sender.in_rate ? g_sender.in_rate : SLT_INGEST_RATE;
	pos = g_sender.resample_pos;
	slt_mutex_unlock(&g_sender.mutex);

	if (in_rate == SLT_INGEST_RATE) {
		ok = slt_send_all(g_sender.sock, (const uint8_t *)in,
				  n * sizeof(int16_t));
		pos = 0;
	} else {
		const double step = (double)in_rate / SLT_INGEST_RATE;

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
						  produced * sizeof(int16_t))) {
					ok = false;
					break;
				}
				produced = 0;
			}
		}
		if (ok && produced > 0)
			ok = slt_send_all(g_sender.sock,
					  (const uint8_t *)out,
					  produced * sizeof(int16_t));

		pos -= (double)n;
		if (pos < 0)
			pos = 0;
	}

	slt_mutex_lock(&g_sender.mutex);
	g_sender.resample_pos = pos;
	slt_mutex_unlock(&g_sender.mutex);
	return ok ? n : 0;
}

/* ---------------------------------------------------------------------- */
/* Sender thread                                                           */
/* ---------------------------------------------------------------------- */

static void sender_loop(void)
{
	uint8_t *chunk = bmalloc(16 * 1024);
	if (!chunk)
		return;

	for (;;) {
		uint32_t port;
		bool reconnect;

		if (g_stopping || slt_events_is_stopped(&g_sender.events))
			break;

		engine_ensure_running();

		/* Consistent snapshot of the shared connection settings. */
		slt_mutex_lock(&g_sender.mutex);
		port = g_sender.port;
		reconnect = g_sender.reconnect_requested;
		g_sender.reconnect_requested = false;
		slt_mutex_unlock(&g_sender.mutex);

		if (reconnect && g_sender.sock != SLT_INVALID_SOCK) {
			slt_close(g_sender.sock);
			g_sender.sock = SLT_INVALID_SOCK;
		}

		/* Ensure we are connected to the engine ingest port. */
		if (g_sender.sock == SLT_INVALID_SOCK) {
			g_sender.sock = slt_connect((uint16_t)port);
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
					slt_mutex_lock(&g_sender.mutex);
					g_sender.resample_pos = 0;
					slt_mutex_unlock(&g_sender.mutex);
					blog(LOG_INFO,
					     "[SLT] connected to engine ingest port %u",
					     port);
				}
			}
		}

		/* Wait for audio (or reconnect timeout). The stop event wakes
		 * this immediately during unload. */
		if (slt_events_wait(&g_sender.events, SLT_RECONNECT_WAIT_MS))
			break;
		if (g_stopping)
			break;
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
				if (!g_stopping)
					blog(LOG_WARNING,
					     "[SLT] ingest send failed, reconnecting");
				slt_close(g_sender.sock);
				g_sender.sock = SLT_INVALID_SOCK;
				break;
			}
			if (g_stopping)
				break;
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
	if (!f)
		return NULL;
	f->source = source;
	f->enabled = obs_data_get_bool(settings, "enabled");
	f->gate_silence = obs_data_get_bool(settings, "gate_silence");
	f->port = (uint32_t)obs_data_get_int(settings, "port");

	/* Deliberately do NOT touch the global ingest port here. A scene
	 * collection can contain several capture filters carrying stale or
	 * conflicting "port" settings; letting each create() overwrite the
	 * shared port made the result depend on source load order and could
	 * point the audio feed at the HTTP port. Only a genuine user edit
	 * (see filter_update) changes it. */
	blog(LOG_INFO, "[SLT] filter attached to source \"%s\"",
	     obs_source_get_name(source));

	slt_mutex_lock(&g_sender.mutex);
	uint32_t shared_port = g_sender.port;
	slt_mutex_unlock(&g_sender.mutex);
	if (f->port != shared_port)
		blog(LOG_WARNING,
		     "[SLT] filter on \"%s\" has a saved port %u, but the shared ingest port is %u; the saved value is ignored",
		     obs_source_get_name(source), f->port, shared_port);
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
	if (!f)
		return;
	f->enabled = obs_data_get_bool(settings, "enabled");
	f->gate_silence = obs_data_get_bool(settings, "gate_silence");

	uint32_t port = (uint32_t)obs_data_get_int(settings, "port");
	if (port < 1024 || port > 65535)
		port = SLT_INGEST_PORT_DEFAULT;

	/* Only reached when the value really changed, i.e. when the user
	 * edited the property. Loading a saved scene must not rewrite the
	 * shared port. */
	if (port != f->port) {
		slt_mutex_lock(&g_sender.mutex);
		g_sender.port = port;
		g_sender.reconnect_requested = true;
		g_sender.head = g_sender.tail = g_sender.used = 0;
		slt_mutex_unlock(&g_sender.mutex);
		f->port = port;
		blog(LOG_INFO, "[SLT] ingest port changed to %u", port);
	}
}

static struct obs_audio_data *filter_audio(void *data,
					   struct obs_audio_data *audio)
{
	struct slt_filter *f = data;
	if (!f || !f->enabled || !audio || audio->frames == 0)
		return audio;

	/* OBS audio filters receive planar float samples. For subtitles we
	 * only need a mono downmix, so use at most the first two (L/R)
	 * planes. Deriving the channel count from the *global* output
	 * speaker layout is unsafe: an individual source can be mono, or be
	 * reconfiguring while a media source reconnects, in which case
	 * data[2..MAX_AV_PLANES] may hold stale pointers. Touching them
	 * from the real-time audio thread is a plausible crash vector. */
	const float *left = (const float *)audio->data[0];
	if (!left)
		return audio;
	const float *right = (const float *)audio->data[1];
	const float scale = right ? 0.5f : 1.0f;

	const uint32_t frames = audio->frames;

	/* Pass 1: RMS gate, allocation-free. */
	if (f->gate_silence) {
		double sq_sum = 0.0;
		for (uint32_t i = 0; i < frames; i++) {
			float v = left[i] + (right ? right[i] : 0.0f);
			v *= scale;
			sq_sum += (double)v * v;
		}
		if ((float)sqrt(sq_sum / (double)frames) < SLT_RMS_GATE)
			return audio;
	}

	audio_t *ao = obs_get_audio();
	const uint32_t rate = ao ? audio_output_get_sample_rate(ao) : 48000;

	/* Pass 2: fixed stack buffer, chunked so we never malloc/free on
	 * the OBS real-time audio thread (one allocation per 10 ms frame
	 * used to add jitter and allocator contention). */
	int16_t mono[SLT_MONO_CHUNK];
	for (uint32_t off = 0; off < frames; off += SLT_MONO_CHUNK) {
		uint32_t n = frames - off;
		if (n > SLT_MONO_CHUNK)
			n = SLT_MONO_CHUNK;

		for (uint32_t i = 0; i < n; i++) {
			float v = left[off + i] +
				  (right ? right[off + i] : 0.0f);
			v *= scale;
			if (v > 1.0f)
				v = 1.0f;
			else if (v < -1.0f)
				v = -1.0f;
			mono[i] = (int16_t)(v * 32767.0f);
		}

		slt_mutex_lock(&g_sender.mutex);
		if (g_stopping) {
			slt_mutex_unlock(&g_sender.mutex);
			break;
		}
		if (rate != g_sender.in_rate) {
			/* Sample rate changed: restart resampler state. */
			g_sender.in_rate = rate ? rate : 48000;
			g_sender.resample_pos = 0;
			g_sender.head = g_sender.tail = g_sender.used = 0;
		}
		ring_push((const uint8_t *)mono, (size_t)n * sizeof(int16_t));
		slt_mutex_unlock(&g_sender.mutex);
		slt_events_signal(&g_sender.events);
	}
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
	memset(&g_sender, 0, sizeof(g_sender));
	g_stopping = false;

#ifdef _WIN32
	if (WSAStartup(MAKEWORD(2, 2), &g_sender.wsa) != 0)
		return false;
#endif

	g_sender.ring = bmalloc(SLT_RING_BYTES);
	if (!g_sender.ring) {
		blog(LOG_WARNING, "[SLT] out of memory allocating ring buffer");
#ifdef _WIN32
		WSACleanup();
#endif
		return false;
	}

	/* INVALID_SOCKET is not zero, so this must be set after the memset. */
	g_sender.sock = SLT_INVALID_SOCK;
	g_sender.port = SLT_INGEST_PORT_DEFAULT;
	g_sender.in_rate = 48000;
#ifndef _WIN32
	g_sender.engine_pid = -1;
#endif

	if (!slt_events_init(&g_sender.events)) {
		blog(LOG_WARNING, "[SLT] failed to initialise sender events");
		bfree(g_sender.ring);
		g_sender.ring = NULL;
#ifdef _WIN32
		WSACleanup();
#endif
		return false;
	}
	slt_mutex_init(&g_sender.mutex);

	engine_spawn();

#ifdef _WIN32
	g_thread = CreateThread(NULL, 0, sender_thread, NULL, 0, NULL);
	g_sender_started = g_thread != NULL;
#else
	g_sender_started =
		pthread_create(&g_thread, NULL, sender_thread, NULL) == 0;
#endif
	if (!g_sender_started)
		blog(LOG_WARNING, "[SLT] failed to start sender thread");

	/* Explicitly pass OUR struct size. libobs copies exactly that many
	 * bytes and zero-fills the rest of its own (possibly larger) struct,
	 * which is what makes a single DLL work across OBS 30/31/32/33+.
	 * The obs_register_source() macro does the same thing, but spelling
	 * it out documents the compatibility contract. */
	obs_register_source_s(&filter_info, sizeof(filter_info));

	blog(LOG_INFO, "[SLT] stream-live-translate plugin loaded");
	return true;
}

void obs_module_unload(void)
{
	/* 1. Signal stop and wake the sender. SO_SNDTIMEO bounds any
	 *    in-flight send() to 300 ms, so the thread is guaranteed to
	 *    reach its exit path promptly. */
	g_stopping = true;
	slt_events_stop(&g_sender.events);

	/* 2. Only free shared state AFTER the thread has actually exited.
	 *    The old fixed 3 s timeout could expire while sender_loop() was
	 *    still using the mutex / ring / WSA, which produced a
	 *    use-after-free crash inside OBS on shutdown. */
	if (g_sender_started) {
#ifdef _WIN32
		if (WaitForSingleObject(g_thread, 10000) != WAIT_OBJECT_0) {
			blog(LOG_WARNING,
			     "[SLT] sender thread did not exit; keeping its state to avoid a crash");
			engine_terminate();
			return;
		}
		CloseHandle(g_thread);
#else
		pthread_join(g_thread, NULL);
#endif
		g_sender_started = false;
	}

	engine_terminate();

	slt_events_destroy(&g_sender.events);
	slt_mutex_destroy(&g_sender.mutex);
	bfree(g_sender.ring);
	g_sender.ring = NULL;

#ifdef _WIN32
	WSACleanup();
#endif
}

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(SLT_MODULE_NAME, "en-US")
