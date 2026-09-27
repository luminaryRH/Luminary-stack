import { useMemo } from "react";
import { useRouter as useTanstackRouter, useRouterState } from "@tanstack/react-router";

export function usePathname() {
  return useRouterState({ select: (state) => state.location.pathname });
}

export function useRouter() {
  const router = useTanstackRouter();
  return useMemo(
    () => ({
      push: (href: string) => {
        void router.navigate({ to: href } as never);
      },
      replace: (href: string) => {
        void router.navigate({ to: href, replace: true } as never);
      },
      prefetch: (href: string) => {
        void Promise.resolve(router.preloadRoute({ to: href } as never)).catch(() => {});
      },
      back: () => router.history.back(),
      forward: () => router.history.forward(),
      refresh: () => location.reload(),
    }),
    [router],
  );
}
