// Native protected-memory adapter only; no emulator logic is substituted here.
#pragma once
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
inline void* TestProtectedPage()
{
  return VirtualAlloc(nullptr, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_NOACCESS);
}
inline bool TestFreeProtectedPage(void* page)
{
  return VirtualFree(page, 0, MEM_RELEASE) != 0;
}
#else
#include <sys/mman.h>
inline void* TestProtectedPage()
{
  void* page = mmap(nullptr, 4096, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  return page == MAP_FAILED ? nullptr : page;
}
inline bool TestFreeProtectedPage(void* page)
{
  return munmap(page, 4096) == 0;
}
#endif
