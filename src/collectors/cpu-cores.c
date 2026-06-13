// Per-core CPU tick reader for macOS, compiled at runtime by Bun's `cc`
// (TinyCC) from cpu-cores-macos.ts.
//
// macOS exposes no per-core CPU% to unprivileged CLI tools, so we call the Mach
// kernel directly: host_processor_info(PROCESSOR_CPU_LOAD_INFO) returns an array
// of cumulative tick counters per logical core. TinyCC can choke on the full
// <mach/mach.h> include tree, so we declare the handful of symbols and constants
// we need by hand — they still resolve from libSystem (linked automatically) at
// link time.

typedef int kern_return_t;
typedef unsigned int natural_t;
typedef natural_t mach_port_t;
typedef mach_port_t host_t;
typedef int processor_flavor_t;
typedef natural_t *processor_info_array_t;
typedef natural_t mach_msg_type_number_t;
typedef unsigned long vm_address_t;
typedef unsigned long vm_size_t;
typedef mach_port_t vm_map_t;

extern mach_port_t mach_host_self(void);
extern kern_return_t host_processor_info(host_t host, processor_flavor_t flavor,
    natural_t *out_processor_count, processor_info_array_t *out_processor_info,
    mach_msg_type_number_t *out_processor_info_count);
extern kern_return_t vm_deallocate(vm_map_t target, vm_address_t address,
    vm_size_t size);
// The current task's port, used to release the array the kernel allocated.
extern mach_port_t mach_task_self_;

#define PROCESSOR_CPU_LOAD_INFO 2
// Each core reports four cumulative tick counters: user, system, idle, nice.
#define CPU_STATE_MAX 4

// Read per-core cumulative CPU ticks. Writes out[core * 4 + state] for each
// logical core (states in CPU_STATE_USER/SYSTEM/IDLE/NICE order) into the
// caller-provided buffer, up to `max_cores`. The counters are unsigned 32-bit
// (natural_t) and widened to 64-bit here; the JS side still diffs two samples
// and handles wraparound.
//
// Returns the logical core count reported by the kernel (which may exceed
// max_cores — the caller should size the buffer from hw.logicalcpu), or -1 if
// the Mach call failed.
int read_core_ticks(unsigned long long *out, int max_cores) {
  natural_t core_count = 0;
  processor_info_array_t info = 0;
  mach_msg_type_number_t info_count = 0;
  kern_return_t kr = host_processor_info(mach_host_self(),
      PROCESSOR_CPU_LOAD_INFO, &core_count, &info, &info_count);
  if (kr != 0) return -1;

  int n = (int)core_count;
  if (n > max_cores) n = max_cores;
  for (int c = 0; c < n; c++) {
    for (int s = 0; s < CPU_STATE_MAX; s++) {
      out[c * CPU_STATE_MAX + s] =
          (unsigned long long)info[c * CPU_STATE_MAX + s];
    }
  }

  // The kernel vm_allocate's `info`; we must release it or the process leaks one
  // array per sample.
  vm_deallocate(mach_task_self_, (vm_address_t)info,
      (vm_size_t)(info_count * sizeof(natural_t)));
  return (int)core_count;
}
