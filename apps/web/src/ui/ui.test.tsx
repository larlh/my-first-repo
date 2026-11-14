import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { i18n } from '@/lib/i18n';
import {
  Button,
  Checkbox,
  ConfirmProvider,
  Dialog,
  ErrorState,
  FileDropzone,
  IconButton,
  Input,
  LoadMore,
  SegmentedControl,
  Select,
  Tabs,
  TabPanel,
  Toaster,
  fileMatchesAccept,
  normalizeHex,
  toast,
  useConfirm,
  validateFiles,
} from '@/ui';

afterEach(async () => {
  toast.clear();
  await i18n.changeLanguage('es');
});

describe('Button / IconButton', () => {
  it('is a real button, blocks clicks while loading and exposes aria-busy', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Guardar</Button>);
    const button = screen.getByRole('button', { name: 'Guardar' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} loading>
        Guardar
      </Button>,
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('asChild renders a link that keeps the button look and its icons', () => {
    render(
      <MemoryRouter>
        <Button asChild variant="primary" leftIcon={<svg data-testid="icon" />}>
          <Link to="/videos">Ver vídeos</Link>
        </Button>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Ver vídeos' });
    expect(link).toHaveAttribute('href', '/videos');
    expect(link.className).toContain('bg-accent');
    expect(within(link).getByTestId('icon')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('IconButton takes its accessible name from `label`', () => {
    render(
      <IconButton label="Eliminar vídeo">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Eliminar vídeo' })).toBeInTheDocument();
  });
});

describe('Input', () => {
  it('links label, hint and error to the control', () => {
    const { rerender } = render(<Input label="Correo" hint="Te escribiremos aquí" />);
    const input = screen.getByLabelText('Correo');
    expect(input).toHaveAccessibleDescription('Te escribiremos aquí');
    expect(input).not.toHaveAttribute('aria-invalid');

    rerender(<Input label="Correo" hint="Te escribiremos aquí" error="Correo no válido" />);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Correo no válido');
    expect(screen.getByRole('alert')).toHaveTextContent('Correo no válido');
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Abrir</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Guardar como plantilla"
          description="Podrás reutilizarla."
          footer={<Button onClick={() => setOpen(false)}>Hecho</Button>}
        >
          <Input label="Nombre" autoFocus />
        </Dialog>
      </>
    );
  }

  it('opens as a labelled modal, traps focus inside and closes with Escape restoring focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Abrir' });
    await user.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'Guardar como plantilla' });
    expect(dialog).toHaveAccessibleDescription('Podrás reutilizarla.');
    expect(within(dialog).getByLabelText('Nombre')).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Cerrar' })).toBeInTheDocument();

    // Tabbing never leaves the dialog.
    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

describe('useConfirm', () => {
  function Harness({ onResult }: { onResult: (value: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <Button
        onClick={() =>
          void confirm({
            title: '¿Eliminar el vídeo?',
            confirmLabel: 'Eliminar',
            tone: 'danger',
          }).then(onResult)
        }
      >
        Borrar
      </Button>
    );
  }

  it('resolves true on confirm and false on cancel', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Harness onResult={onResult} />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Borrar' }));
    const first = await screen.findByRole('alertdialog', { name: '¿Eliminar el vídeo?' });
    await user.click(within(first).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));

    await user.click(screen.getByRole('button', { name: 'Borrar' }));
    const second = await screen.findByRole('alertdialog', { name: '¿Eliminar el vídeo?' });
    await user.click(within(second).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});

describe('Tabs / SegmentedControl / Select / Checkbox', () => {
  it('Tabs switch with the arrow keys', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [tab, setTab] = useState('a');
      return (
        <Tabs
          aria-label="Secciones"
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'a', label: 'Escenas' },
            { value: 'b', label: 'Equipo' },
          ]}
        >
          <TabPanel value="a">Panel escenas</TabPanel>
          <TabPanel value="b">Panel equipo</TabPanel>
        </Tabs>
      );
    }
    render(<Harness />);
    const first = screen.getByRole('tab', { name: 'Escenas' });
    expect(first).toHaveAttribute('aria-selected', 'true');
    await user.click(first);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Equipo' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel equipo');
  });

  it('SegmentedControl is a radio group', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Formato"
        value="16:9"
        onValueChange={onChange}
        options={[
          { value: '16:9', label: '16:9' },
          { value: '9:16', label: '9:16' },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Formato' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '16:9' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: '9:16' }));
    expect(onChange).toHaveBeenCalledWith('9:16');
  });

  it('Select picks an option with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        label="Idioma"
        value="es"
        onValueChange={onChange}
        options={[
          { value: 'es', label: 'Español' },
          { value: 'en', label: 'English' },
        ]}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Idioma' });
    expect(trigger).toHaveTextContent('Español');
    trigger.focus();
    await user.keyboard('{Enter}');
    const option = await screen.findByRole('option', { name: 'English' });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith('en');
  });

  it('Checkbox toggles from its label', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onChange} label="Acepto" />);
    await userEvent.click(screen.getByText('Acepto'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('FileDropzone', () => {
  const png = new File(['x'], 'foto.png', { type: 'image/png' });
  const big = new File([new Uint8Array(2048)], 'grande.png', { type: 'image/png' });
  const pdf = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
  const srt = new File(['x'], 'subs.SRT', { type: '' });

  it('matches MIME types, wildcards and extensions', () => {
    expect(fileMatchesAccept(png, ['image/*'])).toBe(true);
    expect(fileMatchesAccept(png, ['image/png'])).toBe(true);
    expect(fileMatchesAccept(pdf, ['image/*', 'video/mp4'])).toBe(false);
    expect(fileMatchesAccept(srt, ['.srt', '.vtt'])).toBe(true);
    expect(fileMatchesAccept(pdf, undefined)).toBe(true);
  });

  it('splits accepted and rejected files by type, size and count', () => {
    const result = validateFiles([png, big, pdf, png], { accept: ['image/*'], maxSizeBytes: 1024 });
    expect(result.accepted).toEqual([png]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['size', 'type', 'count']);
  });

  it('passes valid files on and explains rejections', async () => {
    const onFiles = vi.fn();
    const { container } = render(
      <FileDropzone
        accept={['image/*']}
        maxSizeBytes={1024}
        onFiles={onFiles}
        description="PNG o JPG"
      />,
    );
    expect(screen.getByRole('button', { name: /Arrastra un archivo/ })).toBeInTheDocument();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, png);
    expect(onFiles).toHaveBeenCalledWith([png]);

    await userEvent.upload(input, big);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('«grande.png» supera el tamaño máximo');
  });
});

describe('ColorPicker helpers', () => {
  it('normalises hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('ff5b2e')).toBe('#ff5b2e');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('rojo')).toBeNull();
  });
});

describe('ErrorState / LoadMore / Toast', () => {
  it('ErrorState translates API error codes and offers retry', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState error={new ApiError('NOT_FOUND', 'Video not found', 404)} onRetry={onRetry} />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No hemos encontrado lo que buscas');
    expect(alert).toHaveTextContent('NOT_FOUND');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ErrorState follows the UI language', async () => {
    await i18n.changeLanguage('en');
    render(<ErrorState error={new ApiError('RATE_LIMITED', 'Too many requests', 429)} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Too many requests in a row. Wait a moment',
    );
  });

  it('LoadMore shows the button only while there are more pages', async () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<LoadMore hasMore loading={false} onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(<LoadMore hasMore={false} loading={false} onLoadMore={onLoadMore} endLabel="Fin" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Fin')).toBeInTheDocument();
  });

  it('toast() renders in the Toaster and can be dismissed', async () => {
    render(<Toaster />);
    toast.success('Vídeo duplicado', { description: 'Lo tienes en la biblioteca.' });
    expect(await screen.findByText('Vídeo duplicado')).toBeInTheDocument();
    expect(screen.getByText('Lo tienes en la biblioteca.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => expect(screen.queryByText('Vídeo duplicado')).toBeNull());
  });
});
