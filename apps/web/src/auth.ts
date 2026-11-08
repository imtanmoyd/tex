import { useEffect, useState } from "react";
import { createAuthStore } from "@tex/core";
import type { AuthState } from "@tex/core";

const authStore = createAuthStore();

export { authStore };
export type { AuthState };

export function useAuth(): AuthState {
  const [state, setState] = useState(authStore.getState());
  useEffect(() => {
    const unsubscribe = authStore.subscribe((next) => setState(next));
    return unsubscribe;
  }, []);
  return state;
}
