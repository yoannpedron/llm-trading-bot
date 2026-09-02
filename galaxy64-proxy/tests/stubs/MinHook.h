#pragma once
// Stub minimal de MinHook pour la verification syntaxique hors MSVC.
typedef enum MH_STATUS {
    MH_UNKNOWN = -1, MH_OK = 0, MH_ERROR_ALREADY_INITIALIZED,
    MH_ERROR_NOT_INITIALIZED, MH_ERROR_ALREADY_CREATED
} MH_STATUS;
#define MH_ALL_HOOKS nullptr
extern "C" {
MH_STATUS MH_Initialize(void);
MH_STATUS MH_Uninitialize(void);
MH_STATUS MH_CreateHook(void* pTarget, void* pDetour, void** ppOriginal);
MH_STATUS MH_RemoveHook(void* pTarget);
MH_STATUS MH_EnableHook(void* pTarget);
MH_STATUS MH_DisableHook(void* pTarget);
const char* MH_StatusToString(MH_STATUS status);
}
