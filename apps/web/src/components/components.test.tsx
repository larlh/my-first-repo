import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { JobStatus, JobStatusBadge } from './JobStatus';
import { ProviderBadge } from './ProviderBadge';
import { VideoPlayer } from './VideoPlayer';

describe('JobStatus', () => {
  it('shows stage, percentage and the server ETA while running', () => {
    render(
      <JobStatus
        label="Render de Bienvenida"
        status="rendering"
        stage="Renderizando fotogramas"
        progress={42.4}
        etaSec={125}
      />,
    );
    expect(screen.getByText('En proceso')).toBeInTheDocument();
    expect(screen.getByText('Renderizando fotogramas')).toBeInTheDocument();
    expect(screen.getByText(/42 % · quedan 2 min 5 s/)).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Render de Bienvenida' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuetext', '42 %, quedan 2 min 5 s');
  });

  it('marks client-side estimates as approximate and admits when the time is unknown', () => {
    const { rerender } = render(
      <JobStatus label="Job" status="processing" progress={10} etaSec={40} etaEstimated />,
    );
    expect(screen.getByText(/quedan ~40 s/)).toBeInTheDocument();
    rerender(<JobStatus label="Job" status="processing" progress={10} etaSec={null} />);
    expect(screen.getByText(/calculando tiempo…/)).toBeInTheDocument();
  });

  it('shows an indeterminate bar while queued and the error when failed', () => {
    const { rerender } = render(<JobStatus label="Job" status="queued" />);
    expect(screen.getByText('En cola')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');

    rerender(<JobStatus label="Job" status="failed" error="No quedan créditos" />);
    expect(screen.getByText('Fallido')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No quedan créditos');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('JobStatusBadge accepts raw resource statuses and custom labels', () => {
    render(
      <>
        <JobStatusBadge status="ready" />
        <JobStatusBadge status="draft" labels={{ idle: 'Borrador' }} />
      </>,
    );
    expect(screen.getByText('Completado')).toBeInTheDocument();
    expect(screen.getByText('Borrador')).toBeInTheDocument();
  });
});

describe('ProviderBadge', () => {
  it('never presents the local provider as high quality', () => {
    render(
      <>
        <ProviderBadge
          provider={{ id: 'espeak', name: 'eSpeak NG', quality: 'basic', local: true }}
        />
        <ProviderBadge
          provider={{ id: 'el', name: 'ElevenLabs', quality: 'premium', local: false }}
        />
      </>,
    );
    expect(screen.getByText('Modo básico · eSpeak NG')).toBeInTheDocument();
    expect(screen.getByText('Alta calidad · ElevenLabs')).toBeInTheDocument();
  });
});

describe('VideoPlayer', () => {
  const subtitles = [
    { lang: 'es', label: 'Español', cues: [{ startMs: 0, endMs: 2000, text: 'Hola a todos' }] },
    { lang: 'en', label: 'English', cues: [{ startMs: 0, endMs: 2000, text: 'Hello everyone' }] },
  ];

  function timeUpdate(video: HTMLVideoElement, seconds: number) {
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      writable: true,
      value: seconds,
    });
    fireEvent.timeUpdate(video);
  }

  it('is a labelled group with named controls', () => {
    const { container } = render(
      <VideoPlayer src="/video.mp4" title="Bienvenida" subtitles={subtitles} />,
    );
    expect(
      screen.getByRole('group', { name: 'Reproductor de vídeo: Bienvenida' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reproducir' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Silenciar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subtítulos' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pantalla completa' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Posición' })).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveAttribute('src', '/video.mp4');
  });

  it('draws the cue of the current time and switches or hides subtitles', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <VideoPlayer src="/video.mp4" title="Bienvenida" subtitles={subtitles} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;

    timeUpdate(video, 1);
    expect(screen.getByText('Hola a todos')).toHaveAttribute('lang', 'es');
    timeUpdate(video, 3);
    expect(screen.queryByText('Hola a todos')).toBeNull();

    timeUpdate(video, 1);
    await user.click(screen.getByRole('button', { name: 'Subtítulos' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'English' }));
    expect(screen.getByText('Hello everyone')).toBeInTheDocument();

    // keyboard shortcut on the player surface: C toggles captions
    const player = screen.getByRole('group', { name: 'Reproductor de vídeo: Bienvenida' });
    player.focus();
    await user.keyboard('c');
    expect(screen.queryByText('Hello everyone')).toBeNull();
    await user.keyboard('c');
    expect(screen.getByText('Hello everyone')).toBeInTheDocument();
  });

  it('starts with captions off when asked and offers a download link', () => {
    const { container } = render(
      <VideoPlayer
        src="/video.mp4"
        title="Bienvenida"
        subtitles={[subtitles[0] as (typeof subtitles)[number]]}
        defaultSubtitleLang={null}
        downloadUrl="/video.mp4"
        downloadName="bienvenida.mp4"
      />,
    );
    timeUpdate(container.querySelector('video') as HTMLVideoElement, 1);
    expect(screen.queryByText('Hola a todos')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mostrar subtítulos' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('link', { name: 'Descargar' })).toHaveAttribute(
      'download',
      'bienvenida.mp4',
    );
  });
});
