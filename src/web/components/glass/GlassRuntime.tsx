import { useAppearance } from '@/state/appearance';
import { useEffect } from 'react';
import { mountGlassRegistry } from './glass-registry';
export function GlassRuntime() { useEffect(() => mountGlassRegistry({ preferences: useAppearance.getState, subscribe: useAppearance.subscribe }), []); return null; }
