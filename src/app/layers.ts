import { Layer } from "effect";
import { CpuCoresCollectorLinuxLive } from "../collectors/cpu-cores-linux.ts";
import { CpuCoresCollectorMacOSLive } from "../collectors/cpu-cores-macos.ts";
import { CpuCollectorLinuxLive } from "../collectors/cpu-linux.ts";
import { CpuCollectorMacOSLive } from "../collectors/cpu-macos.ts";
import { DiskCollectorLinuxLive } from "../collectors/disk-linux.ts";
import { DiskCollectorMacOSLive } from "../collectors/disk-macos.ts";
import { MemoryCollectorLinuxLive } from "../collectors/memory-linux.ts";
import { MemoryCollectorMacOSLive } from "../collectors/memory-macos.ts";
import { NetworkCollectorLinuxLive } from "../collectors/network-linux.ts";
import { NetworkCollectorMacOSLive } from "../collectors/network-macos.ts";
import { ProcessCollectorLinuxLive } from "../collectors/process-linux.ts";
import { ProcessCollectorMacOSLive } from "../collectors/process-macos.ts";

/**
 * Platform layer selection. Every collector is an Effect Service (`Context.Tag`);
 * the only platform-specific code is the Layer implementation. The app depends
 * solely on the Tags, so choosing macOS vs Linux Layers here is the *one* place
 * platform matters — nothing downstream (store, streams, components, config) changes.
 *
 * macOS Layers parse `top`/`vm_stat`/`netstat`/`iostat` (+ a Mach FFI for per-core);
 * Linux Layers read procfs (`/proc/stat`, `/proc/meminfo`, `/proc/net/dev`,
 * `/proc/diskstats`). Both implement the identical service interfaces.
 */

const isLinux = process.platform === "linux";

/** Pick the Linux Layer on Linux, otherwise the macOS Layer (the default). */
const forPlatform = <A, E, R>(
  linux: Layer.Layer<A, E, R>,
  macos: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, R> => (isLinux ? linux : macos);

/** All collector Layers, each resolved to the current platform's implementation. */
export const CollectorsLive = Layer.mergeAll(
  forPlatform(CpuCollectorLinuxLive, CpuCollectorMacOSLive),
  forPlatform(CpuCoresCollectorLinuxLive, CpuCoresCollectorMacOSLive),
  forPlatform(MemoryCollectorLinuxLive, MemoryCollectorMacOSLive),
  forPlatform(NetworkCollectorLinuxLive, NetworkCollectorMacOSLive),
  forPlatform(DiskCollectorLinuxLive, DiskCollectorMacOSLive),
  forPlatform(ProcessCollectorLinuxLive, ProcessCollectorMacOSLive),
);
