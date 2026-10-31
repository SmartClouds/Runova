import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/admin/api';
import { SIGN_IN_PATH } from '@/lib/admin/guard';

interface SignOutButtonProps {
  /** Where the browser goes once signed out; tests replace it. */
  navigate?: (path: string) => void;
}

const goTo = (path: string) => window.location.assign(path);

/** Ends the staff session. A session that already ended counts as signed out. */
export default function SignOutButton({ navigate = goTo }: SignOutButtonProps) {
  const [failure, setFailure] = useState<string | null>(null);

  const signOut = async () => {
    const response = await apiRequest('/sessions/current', { method: 'DELETE' });
    if (response.ok || response.problem.status === 401) {
      navigate(SIGN_IN_PATH);
      return;
    }
    setFailure(response.problem.detail || response.problem.title);
  };

  return (
    <div className="flex items-center gap-3">
      {failure && (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={signOut}>
        Sign out
      </Button>
    </div>
  );
}
