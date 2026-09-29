/**
 * SettingsDialog — modal wrapper for the shared settings surface.
 *
 * The full settings experience lives at /settings. This dialog remains
 * for embed contexts that still need a temporary overlay.
 */

import { useEffect, useState } from 'react';
import { Dialog } from './ui/dialog';
import { SettingsSurface, readLastSettingsSection, writeLastSettingsSection } from './SettingsSurface';
import type { SettingsSection } from './SettingsClient';

export interface SettingsDialogProps {
  open: boolean;
  projectId?: string;
  onClose: () => void;
  initialSection?: SettingsSection;
  onExpand?: (section: SettingsSection) => void;
}

function resolveDialogInitialSection(initialSection: SettingsSection | undefined): SettingsSection {
  return initialSection ?? readLastSettingsSection() ?? 'agents';
}

export function SettingsDialog({ open, onClose, initialSection, onExpand, projectId }: SettingsDialogProps) {
  const [active, setActive] = useState<SettingsSection>(() => resolveDialogInitialSection(initialSection));

  useEffect(() => {
    if (!open) return;
    const nextSection = resolveDialogInitialSection(initialSection);
    setActive(nextSection);
    writeLastSettingsSection(nextSection);
  }, [initialSection, open]);

  const handleActiveChange = (section: SettingsSection) => {
    setActive(section);
    writeLastSettingsSection(section);
  };

  return (
    <Dialog open={open} onClose={onClose} ariaLabel="Settings" size="xl" unstyled>
      <SettingsSurface projectId={projectId} active={active} onActiveChange={handleActiveChange} onClose={onClose} onExpand={onExpand ? () => onExpand(active) : undefined} />
    </Dialog>
  );
}
