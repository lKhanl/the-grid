package runner

import (
	"syscall"
	"time"
	"unsafe"
)

// Windows: every service runs in its own Job Object, which counts the CPU
// time of all its processes (ended ones included) and lists the live ones,
// whose working sets are summed.

var (
	procQueryInformationJobObject = modKernel32.NewProc("QueryInformationJobObject")
	procK32GetProcessMemoryInfo   = modKernel32.NewProc("K32GetProcessMemoryInfo")
)

const (
	jobObjectBasicAccountingInformation = 1
	jobObjectBasicProcessIDList         = 3
	processQueryLimitedInformation      = 0x1000
	maxJobPids                          = 1024
)

type jobAccounting struct {
	TotalUserTime, TotalKernelTime                     int64 // 100 ns units
	ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime int64
	TotalPageFaultCount                                uint32
	TotalProcesses, ActiveProcesses                    uint32
	TotalTerminatedProcesses                           uint32
}

type jobPidList struct {
	Assigned, InList uint32
	IDs              [maxJobPids]uintptr
}

type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

func sampleProcs(procs []*proc) map[*proc]usage {
	out := map[*proc]usage{}
	var list jobPidList // large; reused for every job
	for _, p := range procs {
		p.mu.Lock()
		if p.job != 0 {
			if u, ok := jobUsage(p.job, &list); ok {
				out[p] = u
			}
		}
		p.mu.Unlock()
	}
	return out
}

func jobUsage(job syscall.Handle, list *jobPidList) (usage, bool) {
	var acct jobAccounting
	r, _, _ := procQueryInformationJobObject.Call(uintptr(job), jobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&acct)), unsafe.Sizeof(acct), 0)
	if r == 0 {
		return usage{}, false
	}
	u := usage{cpu: time.Duration(acct.TotalUserTime+acct.TotalKernelTime) * 100}
	// ERROR_MORE_DATA past maxJobPids still fills the list: the first ones count
	*list = jobPidList{}
	procQueryInformationJobObject.Call(uintptr(job), jobObjectBasicProcessIDList,
		uintptr(unsafe.Pointer(list)), unsafe.Sizeof(*list), 0)
	n := min(int(list.InList), maxJobPids)
	for _, pid := range list.IDs[:n] {
		h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
		if err != nil {
			continue
		}
		var pmc processMemoryCounters
		pmc.CB = uint32(unsafe.Sizeof(pmc))
		if r, _, _ := procK32GetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.CB)); r != 0 {
			u.mem += uint64(pmc.WorkingSetSize)
		}
		syscall.CloseHandle(h)
	}
	return u, true
}
