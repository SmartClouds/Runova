import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { AppCard } from './AppCard';
import { appView, fakePictures } from './testing/pictureFixtures';

function renderCard(
  app = appView(),
  pictures = fakePictures(),
): ReturnType<typeof renderWithProviders> & { pictures: typeof pictures } {
  return { ...renderWithProviders(<AppCard app={app} pictures={pictures} />), pictures };
}

const address = () => screen.getByLabelText('Address');

describe('AppCard', () => {
  it('shows nothing for a video with no project', () => {
    renderCard(appView({ project: null }));
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('starts an app that is not running', () => {
    const { pictures } = renderCard();
    expect(screen.getByText('Not running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start the app' }));
    expect(pictures.startApp).toHaveBeenCalled();
  });

  it('holds the button while the app starts', () => {
    renderCard(appView({ status: 'starting' }));
    expect(screen.getByText('Starting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();
  });

  it('holds the button while the start is on its way', () => {
    renderCard(appView(), fakePictures({ pending: 'start' }));
    expect(screen.getByRole('button', { name: 'Starting...' })).toBeDisabled();
  });

  it('says where a running app is and links to it', () => {
    renderCard(appView({ status: 'running', url: 'http://localhost:5173' }));
    expect(screen.getByText('Running at http://localhost:5173')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open it in the browser' })).toHaveAttribute(
      'href',
      'http://localhost:5173',
    );
    expect(screen.queryByRole('button', { name: 'Start the app' })).toBeNull();
  });

  it('does not offer a link before it knows the address', () => {
    renderCard(appView({ status: 'running', url: null }));
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('signs in to a running app', () => {
    const { pictures } = renderCard(appView({ status: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in first' }));
    expect(pictures.signIn).toHaveBeenCalled();
  });

  it('holds sign in while its window opens', () => {
    renderCard(appView({ status: 'running' }), fakePictures({ pending: 'sign-in' }));
    expect(screen.getByRole('button', { name: 'Sign in first' })).toBeDisabled();
  });

  it('stops only an app Studio started itself', () => {
    const { pictures } = renderCard(appView({ status: 'running', startedByStudio: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(pictures.stopApp).toHaveBeenCalled();
  });

  it('leaves an app it found already running alone', () => {
    renderCard(appView({ status: 'running', startedByStudio: false }));
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('saves a new address, and clears it when it is emptied', () => {
    const { pictures } = renderCard(appView({ url: 'http://localhost:3000' }));
    fireEvent.change(address(), { target: { value: ' http://localhost:4000 ' } });
    fireEvent.blur(address());
    expect(pictures.setApp).toHaveBeenLastCalledWith({ url: 'http://localhost:4000' });
    fireEvent.change(address(), { target: { value: '   ' } });
    fireEvent.blur(address());
    expect(pictures.setApp).toHaveBeenLastCalledWith({ url: null });
  });

  it('leaves the address alone when it did not change', () => {
    const { pictures } = renderCard(appView({ url: 'http://localhost:3000' }));
    fireEvent.blur(address());
    expect(pictures.setApp).not.toHaveBeenCalled();
  });

  it('leaves an empty address alone', () => {
    const { pictures } = renderCard();
    fireEvent.blur(address());
    expect(pictures.setApp).not.toHaveBeenCalled();
  });

  it('follows an address found when the app started', () => {
    const pictures = fakePictures();
    const { rerender } = renderWithProviders(<AppCard app={appView()} pictures={pictures} />);
    rerender(
      <AppCard
        app={appView({ status: 'running', url: 'http://localhost:5173' })}
        pictures={pictures}
      />,
    );
    expect(address()).toHaveValue('http://localhost:5173');
  });

  it('picks another run command', async () => {
    const pictures = fakePictures();
    const app = appView({
      project: {
        id: 'p1',
        name: 'Shop',
        runCommands: [
          { id: 'dev', label: 'dev', command: 'npm run dev' },
          { id: 'preview', label: '', command: 'npm run preview' },
        ],
      },
    });
    const { user } = renderCard(app, pictures);
    await user.click(screen.getByRole('combobox', { name: 'Run command' }));
    await user.click(await screen.findByRole('option', { name: 'npm run preview' }));
    expect(pictures.setApp).toHaveBeenCalledWith({ runCommandId: 'preview' });
  });

  it('says what to do about a project with no run command', () => {
    renderCard(appView({ project: { id: 'p1', name: 'Shop', runCommands: [] } }));
    expect(screen.getByText(/The project has no run command/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows why the app did not start', () => {
    renderCard(appView({ status: 'failed', error: 'The app stopped (exit code 1).' }));
    expect(screen.getByText('Did not start')).toBeInTheDocument();
    expect(screen.getByText('The app stopped (exit code 1).')).toBeInTheDocument();
  });

  it('shows what the app printed when asked', () => {
    renderCard(appView({ output: ['compiling', 'Missing script: dev'] }));
    const toggle = screen.getByRole('button', { name: 'What the app printed' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Missing script/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/compiling\s+Missing script: dev/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText(/Missing script/)).toBeNull();
  });
});
