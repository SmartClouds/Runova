import type { SetupLink } from '@/lib/admin/users';
import { CopyField } from './CopyField';
import { formatTime } from './useAdminList';

interface SetupLinkPanelProps {
  id: string;
  label: 'Invitation link' | 'Password reset link';
  link: SetupLink;
}

/**
 * A link that sets a password, to hand to its owner by a channel of the Admin's choice. The site
 * sends no email, and the API never shows the link again.
 */
export function SetupLinkPanel({ id, label, link }: SetupLinkPanelProps) {
  return (
    <div className="grid gap-3 rounded-md border p-4">
      <CopyField
        id={id}
        label={label}
        value={link.url}
        hint={`It works once, until ${formatTime(link.expiresAt)}. Send it to them yourself; this page is the only place it is shown.`}
      />
    </div>
  );
}
