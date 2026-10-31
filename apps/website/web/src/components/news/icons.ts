import {
  Archive,
  CalendarX,
  Info,
  Newspaper,
  OctagonAlert,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import type { Category, Severity } from '../../lib/news/api';

// The lucide icon of each severity and category, from docs/website/design.md.

export const SEVERITY_ICONS: Record<Severity, typeof Info> = {
  info: Info,
  low: ShieldCheck,
  medium: ShieldAlert,
  high: TriangleAlert,
  critical: OctagonAlert,
};

export const CATEGORY_ICONS: Record<Category, typeof Info> = {
  security: Shield,
  release: Tag,
  deprecation: Archive,
  'end-of-life': CalendarX,
  ai: Sparkles,
  tooling: Wrench,
  industry: Newspaper,
};

/** The text color of each severity, written out in full so Tailwind finds every class. */
export const SEVERITY_TEXT: Record<Severity, string> = {
  info: 'text-severity-info',
  low: 'text-severity-low',
  medium: 'text-severity-medium',
  high: 'text-severity-high',
  critical: 'text-severity-critical',
};
