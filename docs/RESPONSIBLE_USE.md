# Uso responsable de Parlante

Parlante genera vídeo de personas que hablan: avatares dibujados, personas sintéticas
fotorrealistas y, con consentimiento, avatares creados a partir de la foto de una persona real
y voces derivadas de una grabación. Este documento dice qué hace el producto para que ese poder
se use bien, qué **no** hace, y qué condiciones debe aceptar quien use Parlante o lo ofrezca a
otras personas.

Está dirigido a dos lectores: **quien usa** Parlante (secciones 1 a 6) y **quien lo despliega**
para terceros (sección 7). Los controles técnicos y sus límites están en
[`SECURITY.md`](SECURITY.md); las licencias de los modelos, en [`MODELS.md`](MODELS.md).

No es asesoramiento jurídico. Si vas a ofrecer Parlante como servicio, revisa con un
profesional la normativa de protección de datos, de imagen y de contenido sintético que te
aplique.

## 1. Condiciones de uso

Al usar Parlante aceptas estas condiciones. Las siete primeras recogen además las restricciones
que la licencia **CreativeML OpenRAIL-M** impone al uso del modelo con el que Parlante genera
retratos (ver [sección 7](#7-si-despliegas-parlante-para-otras-personas)); se aplican a todo lo
que crees con la aplicación, no solo a los retratos.

No usarás Parlante, ni el contenido que generes con él:

1. **Para infringir la ley.** De ninguna forma que vulnere una ley o norma nacional o
   internacional aplicable.
2. **Para dañar a menores.** Para explotar o perjudicar a menores, o intentarlo, de cualquier
   modo. Parlante no genera retratos de menores.
3. **Para desinformar con ánimo de dañar.** Para generar o difundir información
   verificablemente falsa, o contenido, con el propósito de perjudicar a otras personas.
4. **Para exponer datos personales.** Para generar o difundir información personal
   identificable que pueda usarse para dañar a alguien.
5. **Para difamar o acosar.** Para difamar, denigrar o acosar a otras personas.
6. **Para decidir sobre personas o discriminarlas.** Para tomar decisiones totalmente
   automatizadas que afecten negativamente a los derechos de alguien o le creen obligaciones;
   para usos que discriminen o perjudiquen a personas o grupos por su comportamiento social,
   por sus características personales o de personalidad, o por características protegidas por
   la ley; ni para aprovechar la vulnerabilidad de un grupo (por edad o por condición social,
   física o mental) con el fin de alterar su conducta de un modo que cause daño.
7. **Para sustituir a un profesional o a la justicia.** Para dar consejo médico o interpretar
   resultados médicos, ni para generar o difundir información destinada a la administración de
   justicia, la actuación policial o los procesos de inmigración y asilo (por ejemplo, predecir
   que una persona cometerá un delito).

Además:

8. **No suplantarás a nadie.** No crearás un avatar ni una voz de una persona real sin su
   autorización expresa y verificable, ni usarás un avatar o una voz (también los sintéticos)
   para hacer creer que una persona real ha dicho o hecho algo.
9. **No describirás a personas reales al generar un retrato.** La generación desde texto es
   para personas sintéticas, que no existen.
10. **No ocultarás que el contenido es sintético** cuando eso pueda inducir a error. No
    retirarás la marca de contenido generado por IA de un vídeo fotorrealista para presentarlo
    como una grabación real.
11. **Respetarás la retirada del consentimiento.** Si la persona retratada o el titular de la
    voz te lo pide, revocarás su consentimiento en Parlante y dejarás de distribuir lo que ya
    hubieras exportado.

El texto de la licencia es el que manda: las condiciones 1 a 7 la resumen en español, y ante
cualquier diferencia prevalece el Anexo A de CreativeML OpenRAIL-M
(<https://huggingface.co/spaces/CompVis/stable-diffusion-license>).

## 2. Consentimiento: fotos y voces de personas reales

Crear un avatar desde una foto y clonar una voz son las dos operaciones que trabajan con datos
de una persona real. Las dos exigen un **registro de consentimiento** previo, y la API las
rechaza sin él (`403 CONSENT_REQUIRED`): no es un aviso de la interfaz que se pueda saltar.

- **Qué se declara.** Quien lo crea marca una casilla, escribe el nombre completo de la persona
  que consiente e indica si es él mismo o si actúa con su autorización. El texto que acepta es:

  > «Declaro que soy la persona que aparece en esta fotografía, o que cuento con su autorización
  > expresa y verificable, y consiento que Parlante la utilice para generar un avatar animado.
  > Entiendo que no puedo crear avatares de terceros sin su permiso, ni usarlos para suplantar,
  > difamar o engañar.»

  (y su equivalente para la voz: «…la voz de esta grabación es la mía, o cuento con la
  autorización expresa y verificable de su titular…»).

- **Qué se guarda.** El texto exacto aceptado y su versión, el nombre de quien consiente, la
  relación (titular o autorizado), el usuario que lo registró, la fecha, la dirección IP y el
  navegador. Cada registro sirve para **un** avatar o **una** voz, y debe ser del tipo correcto:
  un consentimiento de voz no vale para una foto.

- **Quién puede hacerlo.** Solo una persona con sesión en la aplicación. La API pública `/v1`
  no puede crear avatares de foto ni clonar voces.

- **Revocar.** En **Ajustes → Consentimientos**, un administrador revoca cualquier registro. Al
  hacerlo se borran el avatar o la voz, sus archivos (retrato, recorte, máscara, clips en caché,
  muestra de voz y audio sintetizado con ella), la foto o grabación de origen, la voz en el
  proveedor externo si la había y los rasgos faciales que el motor neuronal guardó en su caché.
  El registro se conserva marcado como revocado, como prueba de que existió y de cuándo se
  retiró. Borrar el avatar o la voz hace la misma limpieza.

Lo que Parlante **no** puede hacer:

- **No verifica la identidad.** La declaración es una afirmación del usuario; Parlante no
  comprueba que la persona de la foto sea quien dice ni que la autorización exista. La
  responsabilidad de que el consentimiento sea real es de quien lo declara, y el registro
  identifica a esa persona.
- **No retira lo ya exportado.** Los vídeos renderizados antes de la revocación siguen
  existiendo hasta que se borran, y las copias descargadas o compartidas quedan fuera del
  alcance de la aplicación. Un vídeo que todavía referencie el avatar o la voz revocados no se
  puede volver a renderizar.
- **No distingue una foto real de una imagen sintética** subida como foto: a toda foto subida
  se le exige consentimiento.

## 3. Personas sintéticas

Los avatares fotorrealistas de stock y los generados desde una descripción son **personas que
no existen**. La descripción que escribes para generar un retrato (edad, rasgos generales, ropa,
fondo) se modera antes de enviarla al motor, con reglas más estrictas que las de un guion: se
bloquean las descripciones de menores, las sexualizadas y las que nombran o describen a personas
reales identificables. El motor encaja después la descripción en una plantilla de retrato de
presentador, de frente y con fondo neutro.

Aun así, un modelo generativo puede producir por azar un rostro parecido al de alguien. Si
detectas un parecido con una persona real, no uses ese retrato: bórralo y genera otro.

## 4. Moderación de contenido

Antes de renderizar, Parlante revisa **todo el texto** del vídeo: guiones, capas de texto,
transcripciones y los valores de las variables (también los de cada fila de un lote y los que
llegan por la API). Revisa igualmente los mensajes y la base de conocimiento del avatar
interactivo, el texto de las vistas previas de voz, las traducciones antes de doblarlas y las
descripciones de retrato. Un texto bloqueado detiene la operación con `422 CONTENT_BLOCKED`,
sin cobrar créditos.

La moderación incluida es **básica**, y así se declara: una lista de términos inequívocos por
categoría (contenido sexual con menores, odio, sexual explícito, violencia, actividades
peligrosas), comparados sobre el texto normalizado. Es una red de seguridad mínima, no un
clasificador:

- no entiende el contexto, la ironía ni los eufemismos;
- solo cubre los idiomas para los que tiene términos (sobre todo español e inglés);
- se puede esquivar con homoglifos o intercalando símbolos entre letras;
- no analiza imágenes, vídeos ni audios subidos, solo texto.

Quien despliegue Parlante puede ampliar la lista (`MODERATION_EXTRA_BLOCKLIST`) o sustituir el
proveedor por uno más capaz: `ModerationProvider` es un punto de extensión. Con el modo local,
**la revisión humana de lo que se publica sigue siendo responsabilidad tuya.**

## 5. Marcado de contenido generado por IA y transparencia

- **Vídeos con avatar fotorrealista.** El MP4 lleva en sus metadatos la marca
  `com.parlante.ai_generated=true` y el comentario «AI-generated video: contains a synthetic,
  AI-animated presenter. Made with Parlante.». La API lo indica con `aiGenerated: true` y la
  página pública para compartir muestra la etiqueta de contenido generado por IA.
- **Vídeos con avatar 2D.** No llevan esa marca: son personajes dibujados que nadie confundiría
  con una grabación. Su voz, sin embargo, también es sintética.
- **Proveedores a la vista.** Cada vídeo, voz y avatar indica qué proveedor lo produjo y si es
  el modo básico local o un servicio externo; el modo básico nunca se presenta como el de alta
  calidad.
- **Marca de agua.** El plan gratuito añade una marca de agua visible de Parlante. Es una marca
  comercial, no un sello de procedencia.

Límites que debes conocer: los metadatos de un MP4 **se pierden** al recodificar el archivo o al
subirlo a la mayoría de redes sociales, y no son una firma criptográfica (Parlante no implementa
C2PA ni marcas de agua invisibles). Por eso la condición 10 te obliga a ti: si publicas un vídeo
fotorrealista donde pueda tomarse por real, indícalo de forma visible en el propio vídeo o junto
a él.

## 6. Tus datos: qué se guarda y cómo se borra

Parlante guarda en tu instalación (base de datos PostgreSQL y almacenamiento de archivos) las
cuentas, los vídeos y sus composiciones, los archivos subidos, los avatares y voces creados, los
registros de consentimiento y el libro de créditos. Sin proveedores externos configurados, nada
sale de la máquina: voz, guion, traducción, retratos, animación y dictado se calculan en local.

Con claves de proveedores externos, el contenido necesario se envía a ese servicio: el texto de
los guiones (Anthropic, ElevenLabs, OpenAI), el audio a transcribir (OpenAI) y la muestra de voz
a clonar (ElevenLabs). Quien configura las claves es responsable de que ese envío esté
permitido y de informar a sus usuarios.

**Clonado de voz local (motor de voz).** Con `pnpm voice-engine` en marcha, las voces en español
se clonan en este equipo con Chatterbox Multilingual (Resemble AI, licencia MIT): la muestra no
sale de la máquina y el motor solo guarda los rasgos de voz derivados de ella, que se borran al
eliminar la voz o revocar su consentimiento (si el motor no responde en ese momento, el borrado
falla de forma visible y se puede repetir). Todo el audio que genera lleva la marca de agua
inaudible Perth, que lo identifica como generado por IA: el motor comprueba la marca antes de
devolver cada audio y no arranca sin ella. El consentimiento es el mismo que para cualquier
clonado y la API pública `/v1` solo puede usar las voces clonadas del propio workspace.

**Dictado por micrófono.** Lo que dictas se convierte en texto y el audio se descarta: no se
almacena en ningún sitio ni queda en los registros, y el texto solo existe en el campo donde lo
has dictado (se guarda si guardas ese campo, como si lo hubieras tecleado). Qué sale del equipo
depende del motor que elijas:

| Motor de dictado                    | Dónde se transcribe                                                    | Qué sale de tu instalación                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local** (por defecto)             | En el servidor de tu propia instalación, con el modelo abierto Whisper | Nada. El audio va del navegador a tu API y se procesa en memoria; funciona sin conexión a internet                                                       |
| **Navegador** (opcional, lo eliges) | Lo decide el navegador (Web Speech API)                                | En Chrome, el audio se envía a los servidores de Google. Parlante no lo recibe ni lo controla; la interfaz lo dice antes del primer uso y pide aceptarlo |

El motor local es siempre local, aunque la instalación tenga claves de proveedores externos. El
micrófono solo se usa mientras dictas y con el permiso que concede el navegador. Es un modelo
pequeño (modo básico): revisa lo dictado antes de usarlo, sobre todo nombres propios y cifras.

| Qué borras                   | Qué desaparece                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Un vídeo                     | Su fila, el MP4, la miniatura, los subtítulos y su enlace público                               |
| Un archivo subido            | El archivo y su miniatura (un vídeo que lo use deja de poder renderizarse hasta que lo edites)  |
| Un avatar de foto o generado | Retrato, recorte, máscara, clips en caché, la foto de origen y los rasgos en la caché del motor |
| Una voz clonada              | El perfil o la voz externa, la muestra de origen y todo el audio sintetizado con ella           |
| Un consentimiento (revocar)  | Lo mismo que borrar el avatar o la voz; el registro queda marcado como revocado                 |
| El workspace                 | Todo su contenido: vídeos, archivos, avatares, voces, plantillas, claves, webhooks y registros  |

Lo que conviene saber:

- Las URLs de los archivos van firmadas y caducan; un enlace antiguo deja de funcionar, y al
  borrar el recurso responde 404 aunque no hubiera caducado.
- El audio de las voces de stock se guarda en una caché compartida identificada por un hash del
  texto; no está asociado a ningún usuario y no se borra al borrar un vídeo.
- **No hay un botón de «borrar mi cuenta»**: se puede borrar un workspace (salvo el último del
  usuario) y todo su contenido, pero eliminar el usuario requiere actuar sobre la base de datos.
  Tampoco hay exportación de datos ni caducidad automática de vídeos o registros. Si la
  normativa te obliga a ofrecerlos, tendrás que añadirlos.
- Las copias de seguridad, si las haces, son tuyas: borrar en Parlante no las modifica.

## 7. Si despliegas Parlante para otras personas

El generador de retratos es **Realistic Vision V6** (un ajuste de Stable Diffusion 1.5),
publicado bajo **CreativeML OpenRAIL-M**. Esa licencia permite el uso comercial y no reclama
derechos sobre las imágenes generadas, pero:

1. **Prohíbe los usos del Anexo A**, que son las condiciones 1 a 7 de la sección 1.
2. **Te obliga a trasladarlos.** Si redistribuyes el modelo o lo ofreces como servicio —y dar
   acceso a terceros a un Parlante con generación de retratos lo es—, debes incluir esas mismas
   restricciones de uso como condición exigible en tus términos con ellos, y entregar una copia
   de la licencia a quien reciba el modelo.
3. **Te hace responsable de lo generado** y de su uso posterior en los términos de la licencia.

En la práctica, antes de abrir una instalación a otras personas:

- Publica unos términos de uso que incluyan, como mínimo, la sección 1 de este documento, y haz
  que tus usuarios los acepten.
- Enlaza o adjunta el texto de la licencia CreativeML OpenRAIL-M.
- Si no puedes asumir esas obligaciones, arranca el motor sin el generador
  (`AVATAR_ENGINE_DOWNLOAD_ARGS=--minimal`): la animación y la preparación de fotos usan
  modelos con licencias MIT y Apache-2.0, sin restricciones de uso, y la aplicación mostrará la
  generación de retratos como no disponible. Los once retratos de stock ya incluidos se
  generaron con ese modelo; la licencia no reclama derechos sobre ellos.
- Sustituye o amplía la moderación local, define quién atiende las peticiones de retirada y
  conserva los registros de consentimiento el tiempo que tu normativa exija.
- Revisa las licencias del resto de componentes ([`MODELS.md`](MODELS.md) y la sección
  «Licencias de terceros» del README; la voz local eSpeak NG es GPL-3.0).

Parlante se entrega sin garantía: quien lo despliega decide para qué se usa y responde de ello.
