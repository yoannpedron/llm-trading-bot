#pragma once
// ============================================================================
// ipc_client.h — Client IPC (Named Pipe) vers le launcher
//
// Envoie des notifications JSON au launcher via un Named Pipe Windows.
// Toutes les fonctions sont non-bloquantes : si le pipe n'existe pas ou
// est occupe, on abandonne silencieusement.
// ============================================================================

namespace proxy {

// Nom du Named Pipe. Le launcher doit creer ce pipe en tant que serveur.
inline constexpr const wchar_t* PIPE_NAME = L"\\\\.\\pipe\\GogLauncherAchievements";

// Envoie une notification de deblocage de succes.
// Payload JSON : {"event":"achievement","name":"<name>","timestamp":<epoch>}
void SendAchievementNotification(const char* achievementName);

// Envoie une notification de persistance (StoreStatsAndAchievements appele).
// Payload JSON : {"event":"store","timestamp":<epoch>}
void SendStoreNotification();

} // namespace proxy
