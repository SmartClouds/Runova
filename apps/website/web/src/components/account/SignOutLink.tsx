import { LogOut } from 'lucide-react';
import { apiRequest } from '@/lib/account/api';

/** Ends this browser's session and goes back to the sign-in page. */
export default function SignOutLink() {
  const signOut = async () => {
    await apiRequest('/sessions/current', { method: 'DELETE' });
    window.location.assign('/account/sign-in');
  };
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
