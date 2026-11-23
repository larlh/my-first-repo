/* Strings of the `auth` namespace. Spanish is the source; English mirrors its shape. */

const es = {
  titles: {
    login: 'Iniciar sesión',
    register: 'Crear cuenta',
    logout: 'Cerrar sesión',
    workspaces: 'Workspaces',
  },
  nav: { workspaces: 'Workspaces' },
  fields: {
    name: 'Nombre',
    namePlaceholder: 'Lucía Ferrer',
    email: 'Correo electrónico',
    emailPlaceholder: 'tu@correo.com',
    password: 'Contraseña',
  },
  password: {
    show: 'Mostrar contraseña',
    hide: 'Ocultar contraseña',
    hint: 'Mínimo {{min}} caracteres.',
    strength: { '1': 'Muy débil', '2': 'Mejorable', '3': 'Buena', '4': 'Fuerte' },
  },
  errors: {
    emailRequired: 'Escribe tu correo.',
    emailInvalid: 'Ese correo no parece válido. Revisa que tenga @ y dominio.',
    emailTaken: 'Ya hay una cuenta con ese correo.',
    passwordRequired: 'Escribe tu contraseña.',
    passwordShort: 'La contraseña necesita al menos 8 caracteres.',
    passwordLong: 'La contraseña no puede pasar de 128 caracteres.',
    nameRequired: 'Dinos cómo te llamas.',
    nameLong: 'El nombre no puede pasar de 80 caracteres.',
    workspaceRequired: 'Ponle un nombre al workspace.',
    workspaceLong: 'El nombre no puede pasar de 60 caracteres.',
  },
  login: {
    title: 'Vuelve a la cabina',
    description: 'Inicia sesión para seguir con tus vídeos.',
    descriptionRedirected: 'Inicia sesión y te llevamos a la página que querías abrir.',
    submit: 'Entrar',
    noAccount: '¿Aún no tienes cuenta?',
    toRegister: 'Crea una gratis',
    signedOut: 'Has cerrado sesión. Hasta la próxima.',
  },
  register: {
    title: 'Crea tu cuenta',
    description: 'En un minuto tendrás tu propio workspace para grabar el primer vídeo.',
    submit: 'Crear cuenta',
    haveAccount: '¿Ya tienes cuenta?',
    toLogin: 'Inicia sesión',
    welcomeCredits_one:
      'Empiezas con {{count}} crédito gratis. Sin tarjeta y sin claves de servicios externos.',
    welcomeCredits_other:
      'Empiezas con {{count}} créditos gratis. Sin tarjeta y sin claves de servicios externos.',
  },
  logout: {
    working: 'Cerrando la sesión…',
    failed: 'No se ha podido cerrar la sesión',
  },
  workspaces: {
    title: 'Workspaces',
    description:
      'Cada workspace tiene sus propios vídeos, miembros y créditos. Elige en cuál quieres trabajar.',
    current: 'Actual',
    currentHint: 'Estás trabajando aquí ahora.',
    planRole: 'Plan {{plan}} · {{role}}',
    since: 'Desde',
    switch: 'Trabajar aquí',
    switched: 'Ahora estás en «{{name}}»',
    switchFailed: 'No se ha podido cambiar de workspace',
    create: 'Nuevo workspace',
    createTitle: 'Nuevo workspace',
    createText:
      'Un espacio aparte, con plan gratuito y sus créditos de bienvenida. Serás su propietario.',
    createAction: 'Crear y cambiar',
    cancel: 'Cancelar',
    name: 'Nombre',
    namePlaceholder: 'Equipo de marketing',
    created: 'Workspace «{{name}}» creado',
    emptyTitle: 'No perteneces a ningún workspace',
    emptyText: 'Crea uno para empezar a hacer vídeos.',
  },
};

export type AuthTranslations = typeof es;

const en: AuthTranslations = {
  titles: {
    login: 'Sign in',
    register: 'Create account',
    logout: 'Sign out',
    workspaces: 'Workspaces',
  },
  nav: { workspaces: 'Workspaces' },
  fields: {
    name: 'Name',
    namePlaceholder: 'Lucy Ferrer',
    email: 'E-mail',
    emailPlaceholder: 'you@mail.com',
    password: 'Password',
  },
  password: {
    show: 'Show password',
    hide: 'Hide password',
    hint: 'At least {{min}} characters.',
    strength: { '1': 'Very weak', '2': 'Could be better', '3': 'Good', '4': 'Strong' },
  },
  errors: {
    emailRequired: 'Enter your e-mail.',
    emailInvalid: 'That e-mail does not look valid. Check the @ and the domain.',
    emailTaken: 'There is already an account with that e-mail.',
    passwordRequired: 'Enter your password.',
    passwordShort: 'The password needs at least 8 characters.',
    passwordLong: 'The password cannot be longer than 128 characters.',
    nameRequired: 'Tell us your name.',
    nameLong: 'The name cannot be longer than 80 characters.',
    workspaceRequired: 'Give the workspace a name.',
    workspaceLong: 'The name cannot be longer than 60 characters.',
  },
  login: {
    title: 'Back to the booth',
    description: 'Sign in to carry on with your videos.',
    descriptionRedirected: 'Sign in and we will take you to the page you wanted to open.',
    submit: 'Sign in',
    noAccount: 'No account yet?',
    toRegister: 'Create one for free',
    signedOut: 'You have signed out. See you soon.',
  },
  register: {
    title: 'Create your account',
    description: 'In a minute you will have your own workspace to record the first video.',
    submit: 'Create account',
    haveAccount: 'Already have an account?',
    toLogin: 'Sign in',
    welcomeCredits_one:
      'You start with {{count}} free credit. No card and no external service keys.',
    welcomeCredits_other:
      'You start with {{count}} free credits. No card and no external service keys.',
  },
  logout: {
    working: 'Signing you out…',
    failed: 'Could not sign out',
  },
  workspaces: {
    title: 'Workspaces',
    description:
      'Each workspace has its own videos, members and credits. Pick the one you want to work in.',
    current: 'Current',
    currentHint: 'You are working here now.',
    planRole: '{{plan}} plan · {{role}}',
    since: 'Since',
    switch: 'Work here',
    switched: 'You are now in “{{name}}”',
    switchFailed: 'Could not switch workspace',
    create: 'New workspace',
    createTitle: 'New workspace',
    createText:
      'A separate space on the free plan with its welcome credits. You will be its owner.',
    createAction: 'Create and switch',
    cancel: 'Cancel',
    name: 'Name',
    namePlaceholder: 'Marketing team',
    created: 'Workspace “{{name}}” created',
    emptyTitle: 'You do not belong to any workspace',
    emptyText: 'Create one to start making videos.',
  },
};

export const translations = { es, en };
