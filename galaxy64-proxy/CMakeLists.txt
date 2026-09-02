# ============================================================================
# CMakeLists.txt — Build de la proxy Galaxy64.dll
#
# Produit une DLL x64 nommee Galaxy64.dll avec les memes exports que
# la vraie DLL du SDK GOG Galaxy.
#
# Prerequis :
#   - CMake 3.15+
#   - Visual Studio 2019+ (toolchain MSVC x64)
#   - Un acces reseau au premier configure (FetchContent recupere MinHook)
#
# Build :
#   mkdir build && cd build
#   cmake .. -G "Visual Studio 17 2022" -A x64
#   cmake --build . --config Release
#
# La DLL produite se trouve dans build/Release/Galaxy64.dll
# ============================================================================

cmake_minimum_required(VERSION 3.15)
project(Galaxy64Proxy LANGUAGES C CXX)

# ---- Standard C++17 ----
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ---- x64 uniquement ----
# La proxy manipule des vtables et des instructions x86-64 (RIP-relatif).
# Rien de tout cela n'a de sens en 32 bits.
if(CMAKE_SIZEOF_VOID_P EQUAL 4)
    message(FATAL_ERROR "Galaxy64Proxy est une cible x64 uniquement. Configurez avec -A x64.")
endif()

# ============================================================================
# MinHook — moteur de detour (trampoline)
# ============================================================================
# Moteur d'interception principal. Le resolveur trouve l'ADRESSE de la
# methode dans Galaxy64_o.dll (scan de signatures), MinHook y pose un
# trampoline. Le patch de vtable par VirtualProtect (src/vtable_hook.cpp)
# ne sert que de repli si le prologue resiste au detour.

# MinHook declare un cmake_minimum_required anterieur a 3.15 : sans forcer
# la politique et la variable, sa cible resterait en /MD et le linker
# refuserait de la marier a notre /MT (LNK2038).
set(CMAKE_POLICY_DEFAULT_CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

include(FetchContent)

FetchContent_Declare(
    minhook
    GIT_REPOSITORY https://github.com/TsudaKageyu/minhook.git
    GIT_TAG        v1.3.3
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(minhook)

# Selon le tag recupere, MinHook expose sa cible sous des noms differents
# (et certaines versions n'ont pas de CMakeLists du tout). On normalise :
# `minhook_target` designera toujours quelque chose de linkable.
if(TARGET minhook)
    set(minhook_target minhook)
elseif(TARGET MinHook)
    set(minhook_target MinHook)
else()
    # Repli : on compile les sources nous-memes.
    message(STATUS "MinHook sans cible CMake — compilation manuelle des sources")
    add_library(minhook_manual STATIC
        ${minhook_SOURCE_DIR}/src/buffer.c
        ${minhook_SOURCE_DIR}/src/hook.c
        ${minhook_SOURCE_DIR}/src/trampoline.c
        ${minhook_SOURCE_DIR}/src/hde/hde64.c
    )
    target_include_directories(minhook_manual PUBLIC ${minhook_SOURCE_DIR}/include)
    set(minhook_target minhook_manual)
endif()

# MinHook doit utiliser le meme CRT que nous (/MT), sinon le linker refuse.
set_property(TARGET ${minhook_target} PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# ---- Sources ----
set(PROXY_SOURCES
    src/dllmain.cpp
    src/galaxy_proxy.cpp
    src/config.cpp
    src/pattern_scanner.cpp
    src/vtable_hook.cpp
    src/interface_resolver.cpp
    src/hooks_common.cpp
    src/hooks_stats.cpp
    src/hooks_user.cpp
    src/ipc_client.cpp
)

set(PROXY_HEADERS
    src/galaxy_types.h
    src/galaxy_proxy.h
    src/config.h
    src/pattern_scanner.h
    src/vtable_hook.h
    src/interface_resolver.h
    src/hooks.h
    src/ipc_client.h
)

# ---- Cible : DLL partagee ----
add_library(Galaxy64 SHARED ${PROXY_SOURCES} ${PROXY_HEADERS})

# ---- Fichier .def pour controler les exports ----
# Les noms decores dans Galaxy64.def correspondent exactement aux
# noms que MSVC x64 genere pour nos fonctions dans namespace galaxy::api.
set_target_properties(Galaxy64 PROPERTIES
    LINK_FLAGS "/DEF:\"${CMAKE_CURRENT_SOURCE_DIR}/Galaxy64.def\""
    OUTPUT_NAME "Galaxy64"
    PREFIX ""              # pas de prefixe "lib" (convention Linux)
    SUFFIX ".dll"
)

# ---- Dependances ----
target_link_libraries(Galaxy64 PRIVATE ${minhook_target} kernel32 version)

# ---- CRT statique : zero dependance a l'execution ----
# /MT embarque le C Runtime dans la DLL. Les utilisateurs finaux n'ont
# rien a installer (pas de Visual C++ Redistributable).
set_target_properties(Galaxy64 PROPERTIES
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)

# ---- Avertissements ----
if(MSVC)
    target_compile_options(Galaxy64 PRIVATE
        /W4           # Niveau d'avertissement eleve
        /WX-          # Ne pas traiter les warnings comme des erreurs (pour l'instant)
        /wd4100       # Parametre formel non reference (normal pour les stubs)
    )
endif()

# ---- Post-build : copie dans un dossier de deploiement ----
# Decommentez pour copier automatiquement la DLL quelque part.
# add_custom_command(TARGET Galaxy64 POST_BUILD
#     COMMAND ${CMAKE_COMMAND} -E copy_if_different
#         $<TARGET_FILE:Galaxy64>
#         "${CMAKE_CURRENT_SOURCE_DIR}/deploy/Galaxy64.dll"
#     COMMENT "Copie de Galaxy64.dll vers deploy/"
# )
