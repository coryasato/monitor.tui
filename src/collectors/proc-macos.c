// Per-process metrics reader for macOS via libproc, compiled at runtime by Bun's
// `cc` (TinyCC) from process-macos.ts.
//
// macOS has no /proc; per-process data comes from libproc. Mirroring cpu-cores.c,
// we hand-declare the handful of symbols and structs we need rather than pulling
// in <libproc.h>/<sys/proc_info.h> (TinyCC chokes on the full include tree). The
// symbols resolve from libSystem, which is linked automatically. The struct
// layouts must match the headers byte-for-byte so the kernel fills the right
// offsets — the full field list is reproduced (not just the fields we read) so
// `sizeof` equals the kernel's expected PROC_PID*_SIZE.

// libproc entry points.
extern int proc_listpids(unsigned int type, unsigned int typeinfo, void *buffer,
    int buffersize);
extern int proc_pidinfo(int pid, int flavor, unsigned long long arg,
    void *buffer, int buffersize);
extern int proc_pidpath(int pid, void *buffer, unsigned int buffersize);
extern unsigned long strlen(const char *s);

#define PROC_ALL_PIDS 1
#define PROC_PIDTASKINFO 4
#define PROC_PIDTBSDINFO 3
#define PROC_PIDPATHINFO_MAXSIZE 4096
#define MAXCOMLEN 16

// struct proc_taskinfo — sizeof must be 96.
struct proc_taskinfo {
  unsigned long long pti_virtual_size;
  unsigned long long pti_resident_size;
  unsigned long long pti_total_user;   // cumulative user CPU time, nanoseconds
  unsigned long long pti_total_system; // cumulative system CPU time, nanoseconds
  unsigned long long pti_threads_user;
  unsigned long long pti_threads_system;
  int pti_policy;
  int pti_faults;
  int pti_pageins;
  int pti_cow_faults;
  int pti_messages_sent;
  int pti_messages_received;
  int pti_syscalls_mach;
  int pti_syscalls_unix;
  int pti_csw;
  int pti_threadnum;
  int pti_numrunning;
  int pti_priority;
};

// struct proc_bsdinfo — sizeof must be 136.
struct proc_bsdinfo {
  unsigned int pbi_flags;
  unsigned int pbi_status;
  unsigned int pbi_xstatus;
  unsigned int pbi_pid;
  unsigned int pbi_ppid;
  unsigned int pbi_uid;
  unsigned int pbi_gid;
  unsigned int pbi_ruid;
  unsigned int pbi_rgid;
  unsigned int pbi_svuid;
  unsigned int pbi_svgid;
  unsigned int pbi_reserved;
  char pbi_comm[MAXCOMLEN];
  char pbi_name[2 * MAXCOMLEN];
  unsigned int pbi_nfiles;
  unsigned int pbi_pgid;
  unsigned int pbi_pjobc;
  unsigned int e_tdev;
  unsigned int e_tpgid;
  int pbi_nice;
  unsigned long long pbi_start_tvsec;
  unsigned long long pbi_start_tvusec;
};

#define NFIELDS 7
#define MAX_PIDS 16384

// Static (BSS), not stack: keeps the per-call frame tiny under TinyCC.
static int pid_buf[MAX_PIDS];
static char path_buf[PROC_PIDPATHINFO_MAXSIZE];

// Read one snapshot of all readable processes. For each, writes NFIELDS u64 into
// `out` — pid, ppid, cpu_time_ns (user+system), rss_bytes, threads, status,
// name_len — and appends `name_len` bytes of the executable path into `names`
// (sequentially; the caller walks both in lockstep). `*names_used` is set to the
// total bytes written to `names`. Returns the number of processes written, or -1
// if PID enumeration failed.
//
// Processes whose task info can't be read (kernel_task, exited mid-scan, or
// owned by another user without privilege) are skipped — they have no CPU/mem to
// report. This mirrors what an unprivileged `top` can actually see.
int read_processes(unsigned long long *out, int max_procs, char *names,
    int names_cap, int *names_used) {
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, pid_buf, (int)sizeof(pid_buf));
  if (bytes <= 0) return -1;
  int npids = bytes / (int)sizeof(int);

  int count = 0;
  int name_off = 0;
  for (int i = 0; i < npids && count < max_procs; i++) {
    int pid = pid_buf[i];
    if (pid <= 0) continue;

    struct proc_taskinfo ti;
    int rt = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, (int)sizeof(ti));
    if (rt < (int)sizeof(ti)) continue; // unreadable → skip

    struct proc_bsdinfo bi;
    int rb = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, (int)sizeof(bi));
    unsigned long long ppid = 0;
    unsigned long long status = 0;
    if (rb >= (int)sizeof(bi)) {
      ppid = (unsigned long long)bi.pbi_ppid;
      status = (unsigned long long)bi.pbi_status;
    }

    // Full untruncated command via proc_pidpath; fall back to the 16-char comm.
    int plen = proc_pidpath(pid, path_buf, (unsigned int)sizeof(path_buf));
    const char *nm = "";
    int nlen = 0;
    if (plen > 0) {
      nm = path_buf;
      nlen = (int)strlen(path_buf);
    } else if (rb >= (int)sizeof(bi)) {
      nm = bi.pbi_comm;
      nlen = (int)strlen(bi.pbi_comm);
    }
    if (nlen > names_cap - name_off) nlen = names_cap - name_off;
    if (nlen < 0) nlen = 0;
    for (int k = 0; k < nlen; k++) names[name_off + k] = nm[k];

    unsigned long long *rec = out + (long)count * NFIELDS;
    rec[0] = (unsigned long long)pid;
    rec[1] = ppid;
    rec[2] = ti.pti_total_user + ti.pti_total_system;
    rec[3] = ti.pti_resident_size;
    rec[4] = (unsigned long long)ti.pti_threadnum;
    rec[5] = status;
    rec[6] = (unsigned long long)nlen;
    name_off += nlen;
    count++;
  }
  *names_used = name_off;
  return count;
}
