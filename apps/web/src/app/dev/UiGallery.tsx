import type { ProviderRef, TimedText } from '@parlante/shared';
import {
  Bell,
  Copy,
  Download,
  Ellipsis,
  Film,
  Info,
  Languages,
  Mail,
  Monitor,
  Pencil,
  Plus,
  Search,
  Smartphone,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { JobStatus, JobStatusBadge } from '@/components/JobStatus';
import { Logo, LogoMark } from '@/components/Logo';
import { ProviderBadge } from '@/components/ProviderBadge';
import { VideoPlayer } from '@/components/VideoPlayer';
import { ApiError } from '@/lib/api/errors';
import { useFormat } from '@/lib/format';
import { changeLocale, currentLocale } from '@/lib/i18n';
import type { JobPhase } from '@/lib/jobs';
import { useTheme } from '@/lib/theme';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  ColorPicker,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  FileDropzone,
  IconButton,
  Input,
  LoadMore,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonText,
  Slider,
  Spinner,
  Switch,
  TBody,
  THead,
  TabPanel,
  Table,
  TableSkeletonRows,
  Tabs,
  Td,
  Textarea,
  Th,
  Tooltip,
  Tr,
  VoiceBars,
  cn,
  toast,
  useConfirm,
} from '@/ui';
import sampleVideo from './sample.mp4';

/* Development-only catalogue of the design system (route /dev/ui). Not shipped: the router
 * only imports this module when `import.meta.env.DEV` is true. Copy is in Spanish on purpose:
 * it is a reference page for the team, not product UI.
 *
 *   /dev/ui?view=light | dark | both     both = the same catalogue in the two themes at once
 */

type View = 'light' | 'dark' | 'both';

const SWATCHES: { group: string; tokens: [name: string, className: string][] }[] = [
  {
    group: 'Superficies',
    tokens: [
      ['bg', 'bg-bg'],
      ['bg-sunken', 'bg-bg-sunken'],
      ['surface', 'bg-surface'],
      ['surface-2', 'bg-surface-2'],
      ['surface-3', 'bg-surface-3'],
      ['line', 'bg-line'],
      ['line-strong', 'bg-line-strong'],
      ['line-control', 'bg-line-control'],
    ],
  },
  {
    group: 'Texto',
    tokens: [
      ['fg', 'bg-fg'],
      ['fg-muted', 'bg-fg-muted'],
      ['fg-subtle', 'bg-fg-subtle'],
      ['inverse', 'bg-inverse'],
    ],
  },
  {
    group: 'Señal y azafrán',
    tokens: [
      ['accent', 'bg-accent'],
      ['accent-hover', 'bg-accent-hover'],
      ['accent-soft', 'bg-accent-soft'],
      ['accent-text', 'bg-accent-text'],
      ['saffron', 'bg-saffron'],
      ['saffron-soft', 'bg-saffron-soft'],
      ['saffron-text', 'bg-saffron-text'],
    ],
  },
  {
    group: 'Estado',
    tokens: [
      ['success', 'bg-success'],
      ['success-soft', 'bg-success-soft'],
      ['warning', 'bg-warning'],
      ['warning-soft', 'bg-warning-soft'],
      ['danger', 'bg-danger'],
      ['danger-soft', 'bg-danger-soft'],
      ['info', 'bg-info'],
      ['info-soft', 'bg-info-soft'],
    ],
  },
  {
    group: 'Barra lateral y media',
    tokens: [
      ['sidebar', 'bg-sidebar'],
      ['sidebar-2', 'bg-sidebar-2'],
      ['sidebar-3', 'bg-sidebar-3'],
      ['media', 'bg-media'],
    ],
  },
];

const CUES_ES: TimedText[] = [
  { startMs: 200, endMs: 2400, text: 'Hola, soy una de las voces de Parlante.' },
  { startMs: 2600, endMs: 5600, text: 'Así se ven los subtítulos sobre el vídeo.' },
];
const CUES_EN: TimedText[] = [
  { startMs: 200, endMs: 2400, text: 'Hi, I am one of the Parlante voices.' },
  { startMs: 2600, endMs: 5600, text: 'This is how subtitles look over the video.' },
];

const LOCAL: ProviderRef = { id: 'espeak', name: 'eSpeak NG', quality: 'basic', local: true };
const PREMIUM: ProviderRef = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  quality: 'premium',
  local: false,
};

const MEMBERS = [
  { id: '1', name: 'Lucía Ferrer', email: 'lucia@ejemplo.com', role: 'Propietaria', videos: 42 },
  { id: '2', name: 'Mateo Rivas', email: 'mateo@ejemplo.com', role: 'Editor', videos: 17 },
  { id: '3', name: 'Aiko Tanaka', email: 'aiko@ejemplo.com', role: 'Lectora', videos: 0 },
];

function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-24 border-t border-line py-8"
    >
      <div className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id={`${id}-title`} className="text-2xl">
          {title}
        </h2>
        {note && <p className="text-sm text-fg-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Demo({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="eyebrow mb-2 text-fg-subtle">{label}</p>
      <div className={cn('flex min-w-0 flex-wrap items-center gap-3', className)}>{children}</div>
    </div>
  );
}

/** A fake job that fills up, to show JobStatus alive without a backend. */
function useSimulatedJob() {
  const [progress, setProgress] = useState(12);
  useEffect(() => {
    const id = window.setInterval(
      () => setProgress((p) => (p >= 100 ? 0 : Math.min(100, p + 4))),
      700,
    );
    return () => window.clearInterval(id);
  }, []);
  return { progress, etaSec: Math.round(((100 - progress) / 4) * 0.7) };
}

function Catalogue() {
  const format = useFormat();
  const confirm = useConfirm();
  const job = useSimulatedJob();

  const [text, setText] = useState('');
  const [script, setScript] = useState('Hola, soy Lucía y hoy te cuento cómo funciona Parlante.');
  const [language, setLanguage] = useState<string>('es');
  const [voice, setVoice] = useState<string | undefined>(undefined);
  const [terms, setTerms] = useState(false);
  const [some, setSome] = useState<boolean | 'indeterminate'>('indeterminate');
  const [captions, setCaptions] = useState(true);
  const [watermark, setWatermark] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [aspect, setAspect] = useState('16:9');
  const [align, setAlign] = useState('left');
  const [color, setColor] = useState('#ff5b2e');
  const [files, setFiles] = useState<File[]>([]);
  const [tab, setTab] = useState('scenes');
  const [pill, setPill] = useState('all');
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [danger, setDanger] = useState(false);
  const [grid, setGrid] = useState(true);
  const [pages, setPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  return (
    <div className="mx-auto w-full max-w-[var(--content-max)] px-4 pb-16 sm:px-8">
      <PageHeader
        className="pt-8"
        eyebrow="Sistema de diseño · Cabina"
        title="Catálogo de componentes"
        description="Todo lo que ofrece el kit de Parlante, con datos de ejemplo. Los features importan desde «@/ui» y «@/components»."
        meta={<Badge tone="saffron">solo desarrollo</Badge>}
        actions={
          <>
            <Button leftIcon={<Download aria-hidden="true" />}>Secundaria</Button>
            <Button variant="primary" leftIcon={<Plus aria-hidden="true" />}>
              Crear vídeo
            </Button>
          </>
        }
      />

      <Section id="marca" title="Marca" note="Logo, color y tipografía">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <Demo label="Logo" className="items-end gap-6">
              <Logo size="sm" />
              <Logo size="md" />
              <Logo size="lg" />
              <LogoMark className="size-12" title="Parlante" />
            </Demo>
            <Demo label="Sobre tinta">
              <div className="booth-grid flex items-center gap-6 rounded-lg bg-sidebar px-6 py-5 text-sidebar-fg">
                <Logo size="lg" />
                <VoiceBars size="md" label={null} />
              </div>
            </Demo>
            <Demo label="Tipografía" className="flex-col items-start gap-2">
              <p className="display text-5xl">Dale voz a tu guion</p>
              <p className="display text-3xl">Bricolage Grotesque — titulares</p>
              <p className="text-lg">Instrument Sans — texto de interfaz, 17 px</p>
              <p className="text-base text-fg-muted">
                Texto base de 15 px para párrafos y controles. Áéíóú ñ ¿? ¡! — «comillas».
              </p>
              <p className="text-sm text-fg-subtle">Texto secundario de 13 px.</p>
              <p className="eyebrow text-fg-muted">Etiqueta de sección</p>
              <p className="nums font-mono text-sm">00:01:05.250 · JetBrains Mono</p>
            </Demo>
          </div>
          <div className="flex flex-col gap-4">
            {SWATCHES.map((group) => (
              <div key={group.group}>
                <p className="eyebrow mb-2 text-fg-subtle">{group.group}</p>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-8 lg:grid-cols-4 xl:grid-cols-8">
                  {group.tokens.map(([name, className]) => (
                    <div key={name} className="min-w-0">
                      <div className={cn('h-10 rounded-md border border-fg/10', className)} />
                      <p className="mt-1 truncate font-mono text-2xs text-fg-muted" title={name}>
                        {name}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section id="button" title="Button · IconButton">
        <div className="grid gap-6">
          <Demo label="Variantes">
            <Button variant="primary">Primaria</Button>
            <Button variant="solid">Sólida</Button>
            <Button>Secundaria</Button>
            <Button variant="ghost">Fantasma</Button>
            <Button variant="danger" leftIcon={<Trash2 aria-hidden="true" />}>
              Eliminar
            </Button>
            <Button variant="link">Enlace</Button>
          </Demo>
          <Demo label="Tamaños y estados">
            <Button variant="primary" size="sm">
              Pequeña
            </Button>
            <Button variant="primary">Mediana</Button>
            <Button variant="primary" size="lg">
              Grande
            </Button>
            <Button variant="primary" loading>
              Renderizando
            </Button>
            <Button disabled>Deshabilitada</Button>
            <Button rightIcon={<Download aria-hidden="true" />}>Descargar MP4</Button>
          </Demo>
          <Demo label="IconButton (el nombre accesible es obligatorio y se muestra como tooltip)">
            <IconButton label="Editar">
              <Pencil aria-hidden="true" />
            </IconButton>
            <IconButton label="Duplicar" variant="secondary">
              <Copy aria-hidden="true" />
            </IconButton>
            <IconButton label="Nuevo" variant="primary">
              <Plus aria-hidden="true" />
            </IconButton>
            <IconButton label="Eliminar" variant="danger" size="sm">
              <Trash2 aria-hidden="true" />
            </IconButton>
            <IconButton label="Cargando" loading>
              <Bell aria-hidden="true" />
            </IconButton>
          </Demo>
        </div>
      </Section>

      <Section
        id="form"
        title="Formularios"
        note="Input · Textarea · Select · Checkbox · Switch · Slider"
      >
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <Input
            label="Título del vídeo"
            placeholder="Bienvenida al equipo"
            value={text}
            onChange={(event) => setText(event.target.value)}
            hint="Lo verás en la biblioteca y en la página pública."
          />
          <Input
            label="Correo"
            type="email"
            defaultValue="lucia@ejemplo"
            leading={<Mail aria-hidden="true" />}
            error="Escribe un correo válido."
            required
          />
          <Input
            aria-label="Buscar"
            placeholder="Buscar avatares…"
            leading={<Search aria-hidden="true" />}
          />
          <Input
            label="Deshabilitado"
            defaultValue="No editable"
            disabled
            optionalLabel="(opcional)"
          />
          <Textarea
            label="Guion de la escena"
            value={script}
            onChange={(event) => setScript(event.target.value)}
            maxLength={280}
            showCount
            hint="Unos 150 caracteres son 10 segundos de locución."
            wrapperClassName="md:col-span-2"
          />
          <Select
            label="Idioma"
            value={language}
            onValueChange={setLanguage}
            options={[
              { value: 'es', label: 'Español', icon: <Languages aria-hidden="true" /> },
              { value: 'en', label: 'English', icon: <Languages aria-hidden="true" /> },
              { value: 'fr', label: 'Français', icon: <Languages aria-hidden="true" /> },
              {
                value: 'de',
                label: 'Deutsch',
                icon: <Languages aria-hidden="true" />,
                disabled: true,
              },
            ]}
          />
          <Select
            label="Voz"
            placeholder="Elige una voz"
            value={voice}
            onValueChange={setVoice}
            error={voice ? undefined : 'Elige una voz para continuar.'}
            options={[
              {
                label: 'Español',
                options: [
                  { value: 'es-f1', label: 'Carmen', description: 'Femenina · cálida' },
                  { value: 'es-m1', label: 'Diego', description: 'Masculina · neutra' },
                ],
              },
              {
                label: 'English',
                options: [{ value: 'en-f1', label: 'Grace', description: 'Female · bright' }],
              },
            ]}
          />
          <div className="flex flex-col gap-3">
            <Checkbox
              checked={terms}
              onCheckedChange={setTerms}
              label="Declaro que tengo el consentimiento de la persona"
              description="Se guarda con fecha, usuario e IP."
            />
            <Checkbox
              checked={some}
              onCheckedChange={(next) => setSome(next)}
              label="Seleccionar todo (estado indeterminado)"
            />
            <Checkbox checked onCheckedChange={() => undefined} label="Deshabilitado" disabled />
            <Checkbox
              checked={false}
              onCheckedChange={() => undefined}
              label="Con error"
              error="Marca la casilla para continuar."
            />
          </div>
          <div className="flex flex-col gap-4">
            <Switch
              checked={captions}
              onCheckedChange={setCaptions}
              label="Subtítulos automáticos"
              description="Se generan a partir del guion."
            />
            <Switch
              checked={watermark}
              onCheckedChange={setWatermark}
              label="Marca de agua"
              labelPosition="start"
            />
            <Switch
              checked={false}
              onCheckedChange={() => undefined}
              label="Deshabilitado"
              disabled
              size="sm"
            />
          </div>
          <Slider
            label="Velocidad de la voz"
            value={speed}
            onValueChange={setSpeed}
            min={0.5}
            max={2}
            step={0.05}
            formatValue={(value) =>
              `${format.number(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`
            }
            hint="Flechas, Inicio y Fin también funcionan."
          />
          <Slider aria-label="Deshabilitado" value={40} onValueChange={() => undefined} disabled />
        </div>
      </Section>

      <Section id="segmented" title="SegmentedControl · ColorPicker · FileDropzone">
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <div className="flex flex-col gap-5">
            <Demo label="Con texto e icono">
              <SegmentedControl
                aria-label="Formato del vídeo"
                value={aspect}
                onValueChange={setAspect}
                options={[
                  { value: '16:9', label: '16:9', icon: <Monitor aria-hidden="true" /> },
                  { value: '9:16', label: '9:16', icon: <Smartphone aria-hidden="true" /> },
                  { value: '1:1', label: '1:1', icon: <Square aria-hidden="true" /> },
                ]}
              />
            </Demo>
            <Demo label="Pequeño, a todo el ancho">
              <SegmentedControl
                aria-label="Alineación"
                size="sm"
                block
                value={align}
                onValueChange={setAlign}
                options={[
                  { value: 'left', label: 'Izquierda' },
                  { value: 'center', label: 'Centro' },
                  { value: 'right', label: 'Derecha' },
                ]}
              />
            </Demo>
            <div className="flex flex-wrap items-end gap-4">
              <ColorPicker label="Color de fondo" value={color} onChange={setColor} />
              <ColorPicker
                aria-label="Color del texto"
                compact
                value="#1b1424"
                onChange={() => undefined}
              />
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <FileDropzone
              accept={['image/*', 'video/mp4']}
              maxSizeBytes={100 * 1024 * 1024}
              multiple
              description="Imágenes o vídeo MP4"
              onFiles={setFiles}
            />
            {files.length > 0 && (
              <ul className="text-sm text-fg-muted">
                {files.map((file) => (
                  <li key={file.name} className="truncate">
                    {file.name} · {format.bytes(file.size)}
                  </li>
                ))}
              </ul>
            )}
            <FileDropzone
              compact
              accept={['.srt', '.vtt']}
              title="Añadir transcripción"
              description="SRT o VTT"
              onFiles={setFiles}
            />
          </div>
        </div>
      </Section>

      <Section id="tabs" title="Tabs">
        <div className="grid gap-8 md:grid-cols-2">
          <Tabs
            aria-label="Secciones del vídeo"
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: 'scenes', label: 'Escenas', icon: <Film aria-hidden="true" /> },
              { value: 'team', label: 'Equipo', badge: <Badge size="sm">3</Badge> },
              { value: 'off', label: 'Deshabilitada', disabled: true },
            ]}
          >
            <TabPanel value="scenes" className="text-sm text-fg-muted">
              Contenido de «Escenas». Las flechas cambian de pestaña.
            </TabPanel>
            <TabPanel value="team" className="text-sm text-fg-muted">
              Contenido de «Equipo».
            </TabPanel>
          </Tabs>
          <Tabs
            aria-label="Filtro"
            variant="pills"
            value={pill}
            onValueChange={setPill}
            tabs={[
              { value: 'all', label: 'Todos' },
              { value: 'instant', label: 'Instantáneos' },
              { value: 'photoreal', label: 'Fotorrealistas' },
            ]}
          >
            <TabPanel value="all" className="text-sm text-fg-muted">
              Variante «pills» para paneles compactos.
            </TabPanel>
            <TabPanel value="instant" className="text-sm text-fg-muted">
              Avatares 2D en tiempo real.
            </TabPanel>
            <TabPanel value="photoreal" className="text-sm text-fg-muted">
              Avatares del motor neuronal local.
            </TabPanel>
          </Tabs>
        </div>
      </Section>

      <Section
        id="overlays"
        title="Superposiciones"
        note="Dialog · Drawer · Menu · Tooltip · Popover · Toast · ConfirmDialog"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setDialog(true)}>Abrir diálogo</Button>
          <Button onClick={() => setDrawer(true)}>Abrir cajón</Button>
          <Menu>
            <MenuTrigger asChild>
              <Button rightIcon={<Ellipsis aria-hidden="true" />}>Menú</Button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuLabel>Vídeo</MenuLabel>
              <MenuItem icon={<Pencil aria-hidden="true" />} trailing="E">
                Editar
              </MenuItem>
              <MenuItem icon={<Copy aria-hidden="true" />}>Duplicar</MenuItem>
              <MenuCheckboxItem checked={grid} onCheckedChange={setGrid}>
                Mostrar cuadrícula
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuItem
                tone="danger"
                icon={<Trash2 aria-hidden="true" />}
                onSelect={() => setDanger(true)}
              >
                Eliminar
              </MenuItem>
            </MenuContent>
          </Menu>
          <Tooltip content="Los tooltips aparecen al pasar el ratón y al enfocar">
            <Button variant="ghost" leftIcon={<Info aria-hidden="true" />}>
              Tooltip
            </Button>
          </Tooltip>
          <Popover>
            <PopoverTrigger asChild>
              <Button>Popover</Button>
            </PopoverTrigger>
            <PopoverContent>
              <p className="text-sm font-semibold">Panel flotante</p>
              <p className="mt-1 text-sm text-fg-muted">
                Para filtros y selectores pequeños. No bloquea la página.
              </p>
            </PopoverContent>
          </Popover>
          <Button
            onClick={() =>
              toast.success('Vídeo duplicado', { description: 'Lo tienes en la biblioteca.' })
            }
          >
            Toast de éxito
          </Button>
          <Button
            onClick={() =>
              toast.error('No se ha podido renderizar', {
                description: 'No quedan créditos suficientes.',
                action: { label: 'Ver planes', onClick: () => undefined },
              })
            }
          >
            Toast de error
          </Button>
          <Button onClick={() => toast.info('Render en cola')}>Toast informativo</Button>
          <Button
            variant="danger"
            onClick={() =>
              void confirm({
                title: '¿Eliminar «Bienvenida al equipo»?',
                description:
                  'El vídeo y sus archivos se borrarán. Esta acción no se puede deshacer.',
                confirmLabel: 'Eliminar vídeo',
                tone: 'danger',
              }).then((ok) => ok && toast('Vídeo eliminado'))
            }
          >
            useConfirm()
          </Button>
        </div>

        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="Guardar como plantilla"
          description="Podrás reutilizar esta composición para vídeos nuevos."
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancelar</Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Guardar plantilla
              </Button>
            </>
          }
        >
          <Input label="Nombre de la plantilla" defaultValue="Explicativo corto" autoFocus />
        </Dialog>
        <Drawer
          open={drawer}
          onOpenChange={setDrawer}
          title="Propiedades de la capa"
          description="Panel lateral modal; en el Studio se usa para inspectores en pantallas estrechas."
          footer={
            <Button variant="primary" onClick={() => setDrawer(false)}>
              Hecho
            </Button>
          }
        >
          <div className="flex flex-col gap-4">
            <Input label="Texto" defaultValue="Hola, equipo" />
            <Slider
              label="Opacidad"
              value={80}
              onValueChange={() => undefined}
              formatValue={(v) => `${v} %`}
            />
          </div>
        </Drawer>
        <ConfirmDialog
          open={danger}
          onOpenChange={setDanger}
          tone="danger"
          title="¿Eliminar este vídeo?"
          description="ConfirmDialog declarativo, abierto desde el menú."
          confirmLabel="Eliminar"
          onConfirm={() => {
            toast('Vídeo eliminado');
          }}
        />
      </Section>

      <Section
        id="data"
        title="Datos"
        note="Badge · Avatar · Card · Table · «cargar más» · Skeleton"
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          <Demo label="Badge">
            <Badge>Neutro</Badge>
            <Badge tone="accent">Acento</Badge>
            <Badge tone="saffron">Créditos</Badge>
            <Badge tone="success" dot>
              Completado
            </Badge>
            <Badge tone="warning">Aviso</Badge>
            <Badge tone="danger">Error</Badge>
            <Badge tone="info">Info</Badge>
            <Badge variant="solid" tone="accent">
              Nuevo
            </Badge>
            <Badge variant="outline">Contorno</Badge>
            <Badge tone="accent" dot pulse size="sm">
              En directo
            </Badge>
          </Demo>
          <Demo label="Avatar (personas y workspaces)">
            <Avatar name="Lucía Ferrer" size="xs" />
            <Avatar name="Mateo Rivas" size="sm" />
            <Avatar name="Aiko Tanaka" />
            <Avatar name="Olu Adeyemi" size="lg" />
            <Avatar name="Estudio Norte" shape="rounded" size="lg" />
            <Avatar name="Parlante" size="xl" shape="rounded" />
          </Demo>
          <div className="grid gap-5 md:grid-cols-3">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Tarjeta</CardTitle>
                  <CardDescription>Contenedor base con cabecera, cuerpo y pie.</CardDescription>
                </div>
                <Badge tone="saffron">Creator</Badge>
              </CardHeader>
              <CardContent className="text-sm text-fg-muted">
                300 créditos al mes, 1080p y sin marca de agua.
              </CardContent>
              <CardFooter>
                <Button size="sm">Cambiar plan</Button>
              </CardFooter>
            </Card>
            <Card interactive asChild>
              <a href="#data">
                <div className="booth-grid flex aspect-video items-center justify-center rounded-t-lg bg-surface-2">
                  <Film className="size-8 text-fg-subtle" aria-hidden="true" />
                </div>
                <CardContent>
                  <p className="font-semibold">Tarjeta interactiva</p>
                  <p className="mt-1 text-sm text-fg-muted">Es un enlace completo: foco y hover.</p>
                </CardContent>
              </a>
            </Card>
            <Card variant="sunken" padded>
              <p className="eyebrow text-fg-subtle">Cargando</p>
              <div className="mt-3 flex items-center gap-3">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="w-2/3" />
                  <Skeleton className="mt-2 h-3 w-1/3" />
                </div>
              </div>
              <SkeletonText className="mt-4" />
            </Card>
          </div>
          <div>
            <Table aria-label="Miembros del workspace">
              <THead>
                <Tr>
                  <Th>Nombre</Th>
                  <Th>Rol</Th>
                  <Th align="right">Vídeos</Th>
                  <Th align="right">
                    <span className="sr-only">Acciones</span>
                  </Th>
                </Tr>
              </THead>
              <TBody>
                {MEMBERS.slice(0, pages === 1 ? 2 : 3).map((member) => (
                  <Tr key={member.id} interactive>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Avatar name={member.name} size="sm" decorative />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{member.name}</p>
                          <p className="truncate text-xs text-fg-muted">{member.email}</p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <Badge>{member.role}</Badge>
                    </Td>
                    <Td align="right" className="nums">
                      {member.videos}
                    </Td>
                    <Td align="right">
                      <IconButton label={`Acciones de ${member.name}`} size="sm">
                        <Ellipsis aria-hidden="true" />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
                {loadingMore && <TableSkeletonRows rows={1} columns={4} />}
              </TBody>
            </Table>
            <LoadMore
              hasMore={pages === 1}
              loading={loadingMore}
              endLabel="No hay más miembros."
              onLoadMore={() => {
                setLoadingMore(true);
                window.setTimeout(() => {
                  setLoadingMore(false);
                  setPages(2);
                }, 900);
              }}
            />
          </div>
        </div>
      </Section>

      <Section id="progress" title="Progreso" note="ProgressBar · Spinner · estado de trabajos">
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <div className="flex flex-col gap-5">
            <ProgressBar label="Subiendo fondo.mp4" value={64} showHeader />
            <ProgressBar
              label="Almacenamiento"
              value={92}
              tone="danger"
              showHeader
              aside="920 MB de 1 GB"
            />
            <ProgressBar label="Preparando" size="sm" />
            <Demo label="Spinner y barras de voz">
              <Spinner size="xs" />
              <Spinner />
              <Spinner size="md" />
              <Spinner size="lg" className="text-accent" />
              <VoiceBars size="sm" />
              <VoiceBars />
              <VoiceBars size="lg" />
              <VoiceBars active={false} label={null} />
            </Demo>
          </div>
          <div className="flex flex-col gap-5">
            <Card padded>
              <JobStatus
                label="Render de «Bienvenida al equipo»"
                status="rendering"
                stage="Renderizando fotogramas"
                progress={job.progress}
                etaSec={job.etaSec}
                etaEstimated
              />
            </Card>
            <Card padded>
              <JobStatus label="Traducción en cola" status="queued" />
            </Card>
            <Card padded>
              <JobStatus
                label="Render fallido"
                status="failed"
                error="No quedan créditos suficientes en este workspace."
              />
            </Card>
            <Demo label="JobStatusBadge">
              {(
                [
                  'idle',
                  'queued',
                  'running',
                  'completed',
                  'partial',
                  'failed',
                  'canceled',
                ] as JobPhase[]
              ).map((phase) => (
                <JobStatusBadge key={phase} status={phase} />
              ))}
            </Demo>
            <Demo label="ProviderBadge (regla de honestidad)">
              <ProviderBadge provider={LOCAL} />
              <ProviderBadge provider={PREMIUM} />
              <ProviderBadge provider={LOCAL} tierOnly size="sm" />
            </Demo>
          </div>
        </div>
      </Section>

      <Section id="states" title="Estados" note="EmptyState · ErrorState">
        <div className="grid gap-5 md:grid-cols-2">
          <Card>
            <EmptyState
              icon={<Film />}
              title="Todavía no hay vídeos"
              description="Escribe un guion, elige un avatar y renderiza tu primer vídeo en unos minutos."
              action={
                <Button variant="primary" leftIcon={<Plus aria-hidden="true" />}>
                  Crear vídeo
                </Button>
              }
              secondaryAction={<Button variant="ghost">Ver plantillas</Button>}
            />
          </Card>
          <Card>
            <ErrorState
              error={new ApiError('SERVICE_UNAVAILABLE', 'upstream unavailable', 503)}
              onRetry={() => toast.info('Reintentando…')}
            />
          </Card>
          <Card>
            <EmptyState size="sm" icon={<Users />} title="Sin invitaciones pendientes" />
          </Card>
          <Card>
            <ErrorState
              size="sm"
              error={new ApiError('PLAN_LIMIT_EXCEEDED', 'Free plan allows 2 members', 403)}
            />
          </Card>
        </div>
      </Section>

      <Section
        id="media"
        title="VideoPlayer"
        note="Controles propios, subtítulos y atajos de teclado"
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <VideoPlayer
            src={sampleVideo}
            title="Vídeo de muestra"
            subtitles={[
              { lang: 'es', label: 'Español', cues: CUES_ES },
              { lang: 'en', label: 'English', cues: CUES_EN },
            ]}
            downloadUrl={sampleVideo}
            downloadName="muestra.mp4"
          />
          <div className="text-sm text-fg-muted">
            <p className="font-semibold text-fg">Atajos con el foco en el reproductor</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {[
                ['Espacio / K', 'Reproducir o pausar'],
                ['← →', 'Retroceder o avanzar 5 s'],
                ['↑ ↓', 'Volumen'],
                ['M', 'Silenciar'],
                ['C', 'Subtítulos'],
                ['F', 'Pantalla completa'],
              ].map(([keys, action]) => (
                <li
                  key={keys}
                  className="flex items-center justify-between gap-4 border-b border-line pb-1.5"
                >
                  <kbd className="rounded-xs border border-line-strong bg-surface-2 px-1.5 font-mono text-xs text-fg">
                    {keys}
                  </kbd>
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
    </div>
  );
}

export default function UiGallery() {
  const theme = useTheme();
  const [params, setParams] = useSearchParams();
  const requested = params.get('view');
  const view: View = requested === 'both' ? 'both' : theme.theme;

  // `?view=light|dark` pins the app theme (handy for screenshots and deep links).
  const { setPreference } = theme;
  useEffect(() => {
    if (requested === 'light' || requested === 'dark') setPreference(requested);
  }, [requested, setPreference]);

  useEffect(() => {
    document.title = 'Catálogo de componentes · Parlante';
  }, []);

  const change = (next: View) => {
    if (next !== 'both') setPreference(next);
    setParams({ view: next }, { replace: true });
  };

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-40 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-bg/90 px-4 py-2.5 backdrop-blur sm:px-8">
        <Logo size="sm" />
        <span className="eyebrow hidden text-fg-subtle sm:inline">/dev/ui</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          leftIcon={<Languages aria-hidden="true" />}
          onClick={() => void changeLocale(currentLocale() === 'es' ? 'en' : 'es')}
        >
          {currentLocale() === 'es' ? 'English' : 'Español'}
        </Button>
        <SegmentedControl
          aria-label="Tema del catálogo"
          size="sm"
          value={view}
          onValueChange={change}
          options={[
            { value: 'light', label: 'Claro' },
            { value: 'dark', label: 'Oscuro' },
            { value: 'both', label: 'Ambos' },
          ]}
        />
      </header>
      {view === 'both' ? (
        <div className="grid xl:grid-cols-2">
          <div data-theme="light" className="min-w-0 bg-bg text-fg">
            <Catalogue />
          </div>
          <div data-theme="dark" className="min-w-0 bg-bg text-fg">
            <Catalogue />
          </div>
        </div>
      ) : (
        <Catalogue />
      )}
    </div>
  );
}
