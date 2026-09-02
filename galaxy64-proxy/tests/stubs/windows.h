#pragma once
// Stub minimal de windows.h : uniquement pour la verification syntaxique
// hors MSVC. N'est PAS compile dans la DLL.
#include <cstdint>
#include <cstddef>
#include <cstdio>
#include <ctime>
#include <cstring>
#include <cstdlib>

// Attention : sous Windows DWORD/WORD font 4 et 2 octets. Sur LP64,
// `unsigned long` en fait 8 — il faut donc des types de taille fixe, sans
// quoi tous les offsets des structures PE sont faux.
typedef uint32_t       DWORD;
typedef int32_t        BOOL;
typedef uint8_t        BYTE;
typedef uint16_t       WORD;
typedef unsigned int   UINT;
typedef void*          LPVOID;
typedef const char*    LPCSTR;
typedef const wchar_t* LPCWSTR;
typedef void*          HANDLE;
typedef void*          HMODULE;
typedef unsigned long long ULONGLONG;
typedef long long      LONGLONG;
typedef unsigned long long ULONG_PTR;

#define MAX_PATH 260
#define APIENTRY
#define TRUE 1
#define FALSE 0
#define DLL_PROCESS_ATTACH 1
#define DLL_PROCESS_DETACH 0
#define GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS 4
#define GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT 2
#define PAGE_READWRITE 4
#define GENERIC_WRITE 0x40000000u
#define OPEN_EXISTING 3
#define ERROR_PIPE_BUSY 231
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define IMAGE_DOS_SIGNATURE 0x5A4D
#define IMAGE_NT_SIGNATURE 0x00004550
#define IMAGE_NT_OPTIONAL_HDR64_MAGIC 0x20b
#define IMAGE_SCN_MEM_EXECUTE 0x20000000
#define IMAGE_DIRECTORY_ENTRY_EXCEPTION 3
#define IMAGE_NUMBEROF_DIRECTORY_ENTRIES 16
#define HIWORD(x) ((WORD)(((DWORD)(x) >> 16) & 0xFFFF))
#define LOWORD(x) ((WORD)((DWORD)(x) & 0xFFFF))

// Les offsets de ces structures doivent etre EXACTS : le test de resolution
// lit un vrai PE avec. Les static_assert plus bas les verrouillent.
struct IMAGE_DOS_HEADER { WORD e_magic; WORD pad[29]; int e_lfanew; };
struct IMAGE_FILE_HEADER {
    WORD Machine; WORD NumberOfSections; DWORD r[3];
    WORD SizeOfOptionalHeader; WORD Characteristics;
};
struct IMAGE_DATA_DIRECTORY { DWORD VirtualAddress; DWORD Size; };
struct IMAGE_OPTIONAL_HEADER64 {
    WORD  Magic;            // 0
    BYTE  pad0[54];
    DWORD SizeOfImage;      // 56
    DWORD SizeOfHeaders;    // 60
    BYTE  pad1[48];
    IMAGE_DATA_DIRECTORY DataDirectory[IMAGE_NUMBEROF_DIRECTORY_ENTRIES]; // 112
};
struct IMAGE_NT_HEADERS64 {
    DWORD Signature; IMAGE_FILE_HEADER FileHeader; IMAGE_OPTIONAL_HEADER64 OptionalHeader;
};
struct IMAGE_SECTION_HEADER {
    BYTE Name[8];
    union { DWORD PhysicalAddress; DWORD VirtualSize; } Misc;
    DWORD VirtualAddress; DWORD SizeOfRawData; DWORD PointerToRawData;
    DWORD r[3]; DWORD Characteristics;
};
static_assert(offsetof(IMAGE_DOS_HEADER, e_lfanew) == 60, "e_lfanew");
static_assert(sizeof(IMAGE_FILE_HEADER) == 20, "IMAGE_FILE_HEADER");
static_assert(offsetof(IMAGE_OPTIONAL_HEADER64, SizeOfImage) == 56, "SizeOfImage");
static_assert(offsetof(IMAGE_OPTIONAL_HEADER64, DataDirectory) == 112, "DataDirectory");
static_assert(offsetof(IMAGE_NT_HEADERS64, OptionalHeader) == 24, "OptionalHeader");
static_assert(sizeof(IMAGE_SECTION_HEADER) == 40, "IMAGE_SECTION_HEADER");
// Comme la vraie macro : en-tete NT + 24 + SizeOfOptionalHeader.
#define IMAGE_FIRST_SECTION(nt) ((const IMAGE_SECTION_HEADER*)((const char*)(nt) + 24 + (nt)->FileHeader.SizeOfOptionalHeader))

struct RUNTIME_FUNCTION { DWORD BeginAddress; DWORD EndAddress; DWORD UnwindInfoAddress; };
struct VS_FIXEDFILEINFO { DWORD dwFileVersionMS; DWORD dwFileVersionLS; };

struct SRWLOCK { void* p; };
#define SRWLOCK_INIT {0}
struct CRITICAL_SECTION { void* p; };

extern "C" {
void  AcquireSRWLockExclusive(SRWLOCK*);
void  ReleaseSRWLockExclusive(SRWLOCK*);
void  AcquireSRWLockShared(SRWLOCK*);
void  ReleaseSRWLockShared(SRWLOCK*);
void  InitializeCriticalSection(CRITICAL_SECTION*);
void  DeleteCriticalSection(CRITICAL_SECTION*);
void  EnterCriticalSection(CRITICAL_SECTION*);
void  LeaveCriticalSection(CRITICAL_SECTION*);
BOOL  DisableThreadLibraryCalls(HMODULE);
HMODULE LoadLibraryA(LPCSTR);
BOOL  FreeLibrary(HMODULE);
void* GetProcAddress(HMODULE, LPCSTR);
BOOL  GetModuleHandleExA(DWORD, LPCSTR, HMODULE*);
DWORD GetModuleFileNameA(HMODULE, char*, DWORD);
DWORD GetLastError();
BOOL  VirtualProtect(void*, size_t, DWORD, DWORD*);
BOOL  FlushInstructionCache(HANDLE, const void*, size_t);
HANDLE GetCurrentProcess();
HANDLE GetProcessHeap();
void* HeapAlloc(HANDLE, DWORD, size_t);
BOOL  HeapFree(HANDLE, DWORD, void*);
UINT  GetPrivateProfileIntA(LPCSTR, LPCSTR, int, LPCSTR);
DWORD GetPrivateProfileStringA(LPCSTR, LPCSTR, LPCSTR, char*, DWORD, LPCSTR);
BOOL  WritePrivateProfileStringA(LPCSTR, LPCSTR, LPCSTR, LPCSTR);
DWORD GetFileVersionInfoSizeA(LPCSTR, DWORD*);
BOOL  GetFileVersionInfoA(LPCSTR, DWORD, DWORD, void*);
BOOL  VerQueryValueA(const void*, LPCSTR, LPVOID*, UINT*);
HANDLE CreateFileW(LPCWSTR, DWORD, DWORD, void*, DWORD, DWORD, HANDLE);
BOOL  WriteFile(HANDLE, const void*, DWORD, DWORD*, void*);
BOOL  CloseHandle(HANDLE);
int   _stricmp(const char*, const char*);
}
inline int strcpy_s(char* d, size_t n, const char* s){ std::strncpy(d,s,n-1); d[n-1]=0; return 0; }
template<size_t N> inline int strcpy_s(char (&d)[N], const char* s){ return strcpy_s(d,N,s); }
inline int strcat_s(char* d, size_t n, const char* s){ std::strncat(d,s,n-1); return 0; }
template<size_t N> inline int strcat_s(char (&d)[N], const char* s){ return strcat_s(d,N,s); }
inline int fopen_s(FILE** f, const char* p, const char* m){ *f=std::fopen(p,m); return *f?0:1; }
inline int localtime_s(struct tm* t, const time_t* s){ return localtime_r(s,t)?0:1; }
