import { Link } from 'react-router-dom';
import { AuthShell } from '../layouts/AuthShell';
import { Button, Input } from '@/ui';

/** Development-only preview of the public page frame (`AuthShell`) with a sample form. */
export default function AuthPreview() {
  return (
    <AuthShell
      title="Vuelve a la cabina"
      description="Inicia sesión para seguir con tus vídeos."
      footer={
        <>
          ¿Aún no tienes cuenta?{' '}
          <Link
            to="/dev/auth"
            className="font-semibold text-accent-text underline-offset-4 hover:underline"
          >
            Crea una gratis
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => event.preventDefault()}>
        <Input
          label="Correo"
          type="email"
          autoComplete="email"
          placeholder="tu@correo.com"
          required
        />
        <Input label="Contraseña" type="password" autoComplete="current-password" required />
        <Button variant="primary" size="lg" type="submit" block>
          Entrar
        </Button>
      </form>
    </AuthShell>
  );
}
