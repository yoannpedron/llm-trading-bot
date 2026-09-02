#pragma once
// ============================================================================
// vtable_hook.h — Deux moteurs d'interception
//
//   VtableHook  : remplace un pointeur dans la vtable (VirtualProtect).
//   DetourHook  : detourne le corps de la fonction (MinHook).
//
// Pourquoi les deux
// -----------------
// Le patch de vtable est le plus sur : il n'ecrit pas un octet de code, il
// n'a pas besoin de decoder le prologue, et il intercepte exactement ce que
// le jeu appelle — y compris via le wrapper SWIG de GalaxyCSharpGlue.dll,
// qui passe forcement par la vtable de l'objet reel. C'est le mode par
// defaut.
//
// Le detour MinHook couvre le cas ou le jeu ne passe PAS par la vtable
// (adresse de methode resolue une fois pour toutes, vtable recopiee dans un
// objet a lui), et le cas ou la vtable est en memoire non modifiable.
// Il s'active avec `[hook] mode=detour` dans galaxy_proxy.ini.
// ============================================================================

#include <cstddef>

namespace proxy {
namespace hook {

// Initialise MinHook. Idempotent ; sans effet si deja fait.
bool InitEngine();

// Retire tous les hooks poses et arrete MinHook.
void ShutdownEngine();

// ============================================================================
// VtableHook — patch d'un slot
// ============================================================================

class VtableHook {
public:
    VtableHook() = default;
    ~VtableHook() { Remove(); }

    VtableHook(const VtableHook&)            = delete;
    VtableHook& operator=(const VtableHook&) = delete;

    // Remplace vtable[index] par `replacement`. L'ancien pointeur reste
    // accessible via Original().
    bool Install(void** vtable, size_t index, void* replacement);

    // Restaure le pointeur d'origine.
    void Remove();

    bool  Installed() const { return m_vtable != nullptr; }
    void* Original()  const { return m_original; }

private:
    void** m_vtable      = nullptr;
    size_t m_index       = 0;
    void*  m_original    = nullptr;
    void*  m_replacement = nullptr;
};

// ============================================================================
// DetourHook — trampoline MinHook
// ============================================================================

class DetourHook {
public:
    DetourHook() = default;
    ~DetourHook() { Remove(); }

    DetourHook(const DetourHook&)            = delete;
    DetourHook& operator=(const DetourHook&) = delete;

    // Detourne `target` vers `replacement`. Original() donne le trampoline
    // permettant d'appeler la fonction d'origine.
    bool Install(void* target, void* replacement);
    void Remove();

    bool  Installed() const { return m_target != nullptr; }
    void* Original()  const { return m_original; }

private:
    void* m_target   = nullptr;
    void* m_original = nullptr;
};

} // namespace hook
} // namespace proxy
