// ============================================================================
// vtable_hook.cpp — Patch de vtable et detour MinHook
// ============================================================================

#include "vtable_hook.h"
#include "galaxy_proxy.h"

#include <MinHook.h>

namespace proxy {
namespace hook {

namespace {
bool g_engineReady = false;
}

bool InitEngine() {
    if (g_engineReady) return true;

    const MH_STATUS st = MH_Initialize();
    // MH_ERROR_ALREADY_INITIALIZED : un autre module de la partie (overlay,
    // autre proxy) a deja demarre MinHook. Ce n'est pas une erreur pour nous.
    if (st == MH_OK || st == MH_ERROR_ALREADY_INITIALIZED) {
        g_engineReady = true;
        return true;
    }

    ProxyLog("MinHook: initialisation echouee (%s)", MH_StatusToString(st));
    return false;
}

void ShutdownEngine() {
    if (!g_engineReady) return;
    MH_DisableHook(MH_ALL_HOOKS);
    MH_Uninitialize();
    g_engineReady = false;
}

// ============================================================================
// VtableHook
// ============================================================================

bool VtableHook::Install(void** vtable, size_t index, void* replacement) {
    if (m_vtable) Remove();
    if (!vtable || !replacement) return false;

    void** slot = vtable + index;

    // Les vtables vivent dans .rdata, en lecture seule.
    DWORD oldProtect = 0;
    if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &oldProtect)) {
        ProxyLog("VtableHook: VirtualProtect refuse pour le slot %zu (erreur %lu)",
                 index, GetLastError());
        return false;
    }

    m_original    = *slot;
    m_replacement = replacement;
    *slot         = replacement;

    DWORD tmp = 0;
    VirtualProtect(slot, sizeof(void*), oldProtect, &tmp);

    // La vtable est en donnees, pas en code, mais un cache d'instructions
    // peut avoir prefetche l'adresse indirecte sur certaines micro-archis.
    FlushInstructionCache(GetCurrentProcess(), slot, sizeof(void*));

    m_vtable = vtable;
    m_index  = index;
    return true;
}

void VtableHook::Remove() {
    if (!m_vtable) return;

    void** slot = m_vtable + m_index;

    // Ne restaurer que si le slot contient encore NOTRE pointeur : si un
    // overlay ou un autre proxy a patche par-dessus entre-temps, ecraser
    // son hook ferait plus de degats que de laisser le notre en place.
    if (*slot == m_replacement) {
        DWORD oldProtect = 0;
        if (VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &oldProtect)) {
            *slot = m_original;
            DWORD tmp = 0;
            VirtualProtect(slot, sizeof(void*), oldProtect, &tmp);
            FlushInstructionCache(GetCurrentProcess(), slot, sizeof(void*));
        }
    } else {
        ProxyLog("VtableHook: slot %zu re-patche par un tiers, laisse en place",
                 m_index);
    }

    m_vtable      = nullptr;
    m_index       = 0;
    m_original    = nullptr;
    m_replacement = nullptr;
}

// ============================================================================
// DetourHook
// ============================================================================

bool DetourHook::Install(void* target, void* replacement) {
    if (m_target) Remove();
    if (!target || !replacement) return false;
    if (!InitEngine()) return false;

    MH_STATUS st = MH_CreateHook(target, replacement, &m_original);
    if (st != MH_OK) {
        ProxyLog("MinHook: MH_CreateHook a echoue sur %p (%s)",
                 target, MH_StatusToString(st));
        m_original = nullptr;
        return false;
    }

    st = MH_EnableHook(target);
    if (st != MH_OK) {
        ProxyLog("MinHook: MH_EnableHook a echoue sur %p (%s)",
                 target, MH_StatusToString(st));
        MH_RemoveHook(target);
        m_original = nullptr;
        return false;
    }

    m_target = target;
    return true;
}

void DetourHook::Remove() {
    if (!m_target) return;
    MH_DisableHook(m_target);
    MH_RemoveHook(m_target);
    m_target   = nullptr;
    m_original = nullptr;
}

} // namespace hook
} // namespace proxy
