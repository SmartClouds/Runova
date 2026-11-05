import { LogOut } from 'lucide-react';
import { apiRequest } from '@/lib/account/api';

/**
 * Ends this browser's session and goes back to the sign-in page. An icon button in the sidebar,
 * or a full row with its words in the phone's account menu.
 */
export default function SignOutLink({ labelled = false }: { labelled?: boolean }) {
  const signOut = async () => {
    await apiRequest('/sessions/current', { method: 'DELETE' });
    window.location.assign('/account/sign-in');
  };
  if (labelled) {
    return (
      <button
        type="button"
        onClick={signOut}
        className="flex w-full items-center gap-2.5 rounded-inner px-3 py-2.5 text-left text-muted-foreground text-sm transition-colors duration-[120ms] hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <LogOut className="size-4" aria-hidden />
        Sign out
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={signOut}
      title="Sign out"
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-[120ms] hover:bg-foreground/[0.07] hover:text-foreground"
    >
      <LogOut className="size-4" aria-hidden />
      <span className="sr-only">Sign out</span>
    </button>
  );
}
