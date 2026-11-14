import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { FeatureRegistry } from './features';

const EMPTY: FeatureRegistry = { features: [], routes: [], nav: [], problems: [] };
const RegistryContext = createContext<FeatureRegistry>(EMPTY);

/** Makes the feature registry available to the layout (navigation, well-known links). */
export function RegistryProvider({
  registry,
  children,
}: {
  registry: FeatureRegistry;
  children: ReactNode;
}) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useRegistry(): FeatureRegistry {
  return useContext(RegistryContext);
}
