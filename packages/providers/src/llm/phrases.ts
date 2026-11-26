import type { LanguageCode, ScriptTone } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Phrasebook of the local script writer ("modo básico"). The heuristic cannot know facts
 * about a topic, so these sentences give a video its STRUCTURE (opening, angles, closing) and
 * frame whatever the user supplied (topic, key points, source text). Spanish and English
 * have tone-specific openings and closings and seven body angles; the other languages have a
 * neutral set with five.
 *
 * Placeholders: {topic} the subject as typed · {it} a short reference to it ("este tema") ·
 * {audience}. Sentences are written so that {topic} reads naturally after "de / sobre /
 * about" or after a colon.
 * ----------------------------------------------------------------------------------------- */

export type BodyRole = 'what' | 'why' | 'how' | 'tip' | 'mistakes' | 'example' | 'results';

export interface RoleText {
  title: string;
  headline: string;
  /** In order of importance: the first ones are used when the video is short. */
  sentences: string[];
}

export interface ScriptPhrasebook {
  hookTitle: string;
  closeTitle: string;
  closeHeadline: string;
  /** Opening per tone; `default` is used for tones without their own set. */
  hook: Partial<Record<ScriptTone, string[]>> & { default: string[] };
  close: Partial<Record<ScriptTone, string[]>> & { default: string[] };
  body: Partial<Record<BodyRole, RoleText>>;
  /** Short reference to the subject after its first mention. */
  it: string;
  audience: string;
  /** Introduces the n-th key point supplied by the user: "Punto {n}: {point}." */
  pointLead: string;
  /** Sentences that follow a key point supplied by the user. */
  pointFillers: string[];
  /** Opening line when the script summarises a source text (page, notes). */
  sourceHook: string;
  /** Title of the n-th scene built from source text: "Parte {n}". */
  partTitle: string;
  /**
   * Leading words of a topic that may lose their capital when the topic is placed inside a
   * sentence ("Cómo ahorrar" → "… sobre cómo ahorrar"). Anything else is kept as typed
   * (it may be a proper noun).
   */
  lowerFirst: string[];
}

const ES: ScriptPhrasebook = {
  hookTitle: 'Introducción',
  closeTitle: 'Cierre',
  closeHeadline: 'En resumen',
  hook: {
    default: [
      'Hoy hablamos de {topic}.',
      'En los próximos minutos repasamos lo esencial, de forma clara y ordenada.',
      'Al terminar tendrás una visión completa y sabrás cuál es el siguiente paso.',
    ],
    friendly: [
      '¡Hola! Hoy te cuento, sin complicaciones, lo más importante sobre {topic}.',
      'Vamos paso a paso, como si lo habláramos tomando un café.',
      'Quédate hasta el final, que lo mejor llega con los consejos prácticos.',
    ],
    enthusiastic: [
      '¡Prepárate, porque hoy toca hablar de {topic}!',
      'Es uno de esos temas que, cuando los descubres, ya no quieres soltar.',
      '¡Vamos a verlo de principio a fin!',
    ],
    educational: [
      'En esta lección vamos a aprender sobre {topic}.',
      'Empezaremos por los conceptos básicos y avanzaremos poco a poco.',
      'Al final haremos un repaso para fijar las ideas principales.',
    ],
    persuasive: [
      'Hay una razón por la que cada vez más gente presta atención a un tema: {topic}.',
      'Quien lo entiende a tiempo toma mejores decisiones.',
      'Dame un momento y te explico por qué te conviene.',
    ],
    humorous: [
      'Hoy toca hablar de {topic}. Calma: prometo que no habrá examen.',
      'Lo vamos a explicar sin tecnicismos y sin que nadie se duerma.',
      'Y si alguien se duerme, que al menos sea con una buena idea en la cabeza.',
    ],
  },
  close: {
    default: [
      'En resumen, esta es la idea principal de hoy: {topic}.',
      'Si quieres profundizar, da el siguiente paso y ponlo en práctica esta misma semana.',
      'Gracias por tu atención.',
    ],
    friendly: [
      'Y hasta aquí el repaso de hoy sobre {topic}.',
      'Espero que te haya resultado útil. Si te quedan dudas, aquí estamos.',
      '¡Nos vemos en el próximo vídeo!',
    ],
    enthusiastic: [
      '¡Y eso es lo esencial sobre {topic}!',
      'Ahora te toca a ti: ¡ponlo en práctica hoy mismo!',
      '¡Nos vemos muy pronto!',
    ],
    educational: [
      'Repasemos. Hoy hemos visto lo esencial sobre {topic}.',
      'Vuelve a este vídeo siempre que necesites refrescar las ideas principales.',
      'En la próxima lección daremos un paso más.',
    ],
    persuasive: [
      'Ya lo has visto: merece la pena tomarse en serio este tema: {topic}.',
      'No lo dejes para mañana: da el primer paso hoy.',
      'Cuanto antes empieces, antes verás los resultados.',
    ],
    humorous: [
      'Y hasta aquí el vídeo sobre {topic}, sin exámenes y sin bostezos.',
      'Ahora ya puedes presumir de saber del tema en la próxima reunión.',
      '¡Hasta la próxima!',
    ],
  },
  body: {
    what: {
      title: 'Qué es',
      headline: 'Lo esencial',
      sentences: [
        'Empecemos por lo básico: de qué hablamos exactamente cuando hablamos de {it}.',
        'Conviene tener clara la idea central antes de entrar en los detalles.',
        'Con esa base, todo lo demás se entiende mucho mejor.',
        'Si tuvieras que explicarlo en una sola frase, ¿cuál sería? Esa es la idea que debe quedar.',
      ],
    },
    why: {
      title: 'Por qué importa',
      headline: 'Por qué importa',
      sentences: [
        '¿Por qué merece tu atención? Porque {it} influye en los resultados más de lo que parece.',
        'Entenderlo bien ahorra tiempo, evita errores y ayuda a decidir mejor.',
        'Ignorarlo, en cambio, suele salir caro a medio plazo.',
        'Por eso vale la pena dedicarle estos minutos.',
      ],
    },
    how: {
      title: 'Cómo empezar',
      headline: 'Paso a paso',
      sentences: [
        '¿Cómo se pone en práctica? En tres pasos.',
        'Primero, define qué quieres conseguir. Segundo, empieza por algo pequeño y concreto. Tercero, revisa el resultado y ajusta.',
        'No hace falta hacerlo perfecto el primer día: lo importante es empezar.',
        'Con cada repetición, el proceso se vuelve más sencillo.',
      ],
    },
    tip: {
      title: 'Consejo práctico',
      headline: 'Un consejo',
      sentences: [
        'Un consejo práctico: apunta desde el principio lo que funciona y lo que no.',
        'Esos apuntes valen oro cuando toca mejorar.',
        'Y si tienes dudas, pregunta a alguien que ya haya pasado por lo mismo: ahorra mucho camino.',
      ],
    },
    mistakes: {
      title: 'Errores frecuentes',
      headline: 'Qué evitar',
      sentences: [
        'También conviene saber qué evitar.',
        'El error más frecuente es querer abarcarlo todo de golpe.',
        'El segundo es no medir: sin datos es imposible saber si vas por buen camino.',
        'Evitar estos dos errores ya te pone por delante de la mayoría.',
      ],
    },
    example: {
      title: 'Un ejemplo',
      headline: 'En la práctica',
      sentences: [
        'Veámoslo con un ejemplo.',
        'Imagina a alguien que parte de cero y le dedica quince minutos al día.',
        'En pocas semanas nota la diferencia: más claridad, menos improvisación y mejores decisiones.',
        'Ese es el efecto de la constancia.',
      ],
    },
    results: {
      title: 'Qué puedes esperar',
      headline: 'Resultados',
      sentences: [
        '¿Qué puedes esperar a cambio?',
        'Más claridad para decidir, menos tiempo perdido y resultados que se pueden medir.',
        'No ocurre de un día para otro, pero los primeros avances llegan pronto.',
        'Y cada avance facilita el siguiente.',
      ],
    },
  },
  it: 'este tema',
  audience: 'Este vídeo está pensado para {audience}.',
  pointLead: 'Punto {n}: {point}.',
  pointFillers: [
    'Es una de las claves de {it}.',
    'Tenlo presente desde el principio: marca la diferencia en el resultado final.',
    'Dedícale un momento, porque suele pasarse por alto.',
    'Si solo vas a recordar una cosa de este vídeo, que sea esta.',
  ],
  sourceHook: 'Hoy repasamos las ideas principales de: {topic}.',
  partTitle: 'Parte {n}',
  lowerFirst: [
    'cómo',
    'como',
    'por',
    'qué',
    'que',
    'cuándo',
    'dónde',
    'el',
    'la',
    'los',
    'las',
    'un',
    'una',
    'unos',
    'unas',
    'nuestro',
    'nuestra',
    'nuestros',
    'nuestras',
    'mi',
    'mis',
    'tu',
    'tus',
    'su',
    'sus',
    'guía',
    'consejos',
    'claves',
    'ventajas',
    'beneficios',
    'novedades',
    'introducción',
    'presentación',
    'lanzamiento',
    'formación',
    'todo',
    'cinco',
    'tres',
    'diez',
  ],
};

const EN: ScriptPhrasebook = {
  hookTitle: 'Introduction',
  closeTitle: 'Closing',
  closeHeadline: 'In short',
  hook: {
    default: [
      'Today we are talking about {topic}.',
      'In the next few minutes we will go through the essentials, clearly and in order.',
      'By the end you will have the full picture and know what the next step is.',
    ],
    friendly: [
      'Hi there! Today I will walk you through the most important things about {topic}.',
      'We will take it step by step, as if we were chatting over coffee.',
      'Stay until the end: the practical tips are the best part.',
    ],
    enthusiastic: [
      'Get ready, because today is all about {topic}!',
      'It is one of those subjects you cannot put down once you discover it.',
      'Let us go through it from start to finish!',
    ],
    educational: [
      'In this lesson we are going to learn about {topic}.',
      'We will start with the basic concepts and build up little by little.',
      'At the end we will review the main ideas so they stick.',
    ],
    persuasive: [
      'There is a reason more and more people are paying attention to one subject: {topic}.',
      'Those who understand it early make better decisions.',
      'Give me a moment and I will show you why it is worth your time.',
    ],
    humorous: [
      'Today we are talking about {topic}. Relax: there will be no exam.',
      'We will explain it without jargon and without anyone falling asleep.',
      'And if someone does fall asleep, at least let it be with a good idea in mind.',
    ],
  },
  close: {
    default: [
      'To sum up, this is the main idea of today: {topic}.',
      'If you want to go deeper, take the next step and put it into practice this week.',
      'Thank you for watching.',
    ],
    friendly: [
      'And that is our quick tour of {topic}.',
      'I hope it was useful. If you still have questions, we are here to help.',
      'See you in the next video!',
    ],
    enthusiastic: [
      'And those are the essentials of {topic}!',
      'Now it is your turn: put it into practice today!',
      'See you very soon!',
    ],
    educational: [
      'Let us review. Today we covered the essentials of {topic}.',
      'Come back to this video whenever you need to refresh the main ideas.',
      'In the next lesson we will go one step further.',
    ],
    persuasive: [
      'You have seen it: this subject deserves to be taken seriously: {topic}.',
      'Do not leave it for tomorrow: take the first step today.',
      'The sooner you start, the sooner you will see results.',
    ],
    humorous: [
      'And that was our video about {topic}, with no exams and no yawning.',
      'Now you can show off what you know at the next meeting.',
      'Until next time!',
    ],
  },
  body: {
    what: {
      title: 'What it is',
      headline: 'The essentials',
      sentences: [
        'Let us start with the basics: what exactly we mean when we talk about {it}.',
        'It helps to have the central idea clear before going into the details.',
        'With that foundation, everything else is much easier to follow.',
        'If you had to explain it in a single sentence, what would it be? That is the idea to keep.',
      ],
    },
    why: {
      title: 'Why it matters',
      headline: 'Why it matters',
      sentences: [
        'Why does it deserve your attention? Because {it} affects results more than it seems.',
        'Understanding it well saves time, prevents mistakes and leads to better decisions.',
        'Ignoring it, on the other hand, usually turns out to be expensive.',
        'That is why it is worth these few minutes.',
      ],
    },
    how: {
      title: 'How to get started',
      headline: 'Step by step',
      sentences: [
        'How do you put it into practice? In three steps.',
        'First, define what you want to achieve. Second, start with something small and concrete. Third, review the result and adjust.',
        'It does not have to be perfect on day one: what matters is getting started.',
        'With every repetition, the process becomes easier.',
      ],
    },
    tip: {
      title: 'A practical tip',
      headline: 'One tip',
      sentences: [
        'A practical tip: from the very beginning, write down what works and what does not.',
        'Those notes are worth gold when it is time to improve.',
        'And if you are unsure, ask someone who has already been through it: it saves a lot of time.',
      ],
    },
    mistakes: {
      title: 'Common mistakes',
      headline: 'What to avoid',
      sentences: [
        'It also helps to know what to avoid.',
        'The most common mistake is trying to cover everything at once.',
        'The second is not measuring: without data you cannot know whether you are on the right track.',
        'Avoiding these two mistakes already puts you ahead of most people.',
      ],
    },
    example: {
      title: 'An example',
      headline: 'In practice',
      sentences: [
        'Let us look at an example.',
        'Imagine someone who starts from scratch and spends fifteen minutes a day on it.',
        'Within a few weeks the difference shows: more clarity, less improvising and better decisions.',
        'That is the effect of consistency.',
      ],
    },
    results: {
      title: 'What to expect',
      headline: 'Results',
      sentences: [
        'What can you expect in return?',
        'More clarity when deciding, less wasted time and results you can measure.',
        'It does not happen overnight, but the first improvements come quickly.',
        'And each improvement makes the next one easier.',
      ],
    },
  },
  it: 'this topic',
  audience: 'This video is made for {audience}.',
  pointLead: 'Point {n}: {point}.',
  pointFillers: [
    'It is one of the keys to {it}.',
    'Keep it in mind from the start: it makes a difference to the final result.',
    'Give it a moment, because it is often overlooked.',
    'If you only remember one thing from this video, make it this one.',
  ],
  sourceHook: 'Today we go through the main ideas of: {topic}.',
  partTitle: 'Part {n}',
  lowerFirst: [
    'how',
    'why',
    'what',
    'when',
    'where',
    'the',
    'a',
    'an',
    'our',
    'my',
    'your',
    'their',
    'tips',
    'benefits',
    'introduction',
    'getting',
    'using',
    'building',
    'five',
    'three',
    'ten',
    'new',
  ],
};

/** Compact, tone-neutral set for the remaining languages. */
function neutral(book: {
  hookTitle: string;
  closeTitle: string;
  closeHeadline: string;
  hook: string[];
  close: string[];
  what: RoleText;
  why: RoleText;
  how: RoleText;
  tip: RoleText;
  results: RoleText;
  it: string;
  audience: string;
  pointLead: string;
  pointFillers: string[];
  sourceHook: string;
  partTitle: string;
  lowerFirst: string[];
}): ScriptPhrasebook {
  return {
    hookTitle: book.hookTitle,
    closeTitle: book.closeTitle,
    closeHeadline: book.closeHeadline,
    hook: { default: book.hook },
    close: { default: book.close },
    body: {
      what: book.what,
      why: book.why,
      how: book.how,
      tip: book.tip,
      results: book.results,
    },
    it: book.it,
    audience: book.audience,
    pointLead: book.pointLead,
    pointFillers: book.pointFillers,
    sourceHook: book.sourceHook,
    partTitle: book.partTitle,
    lowerFirst: book.lowerFirst,
  };
}

const FR = neutral({
  hookTitle: 'Introduction',
  closeTitle: 'Conclusion',
  closeHeadline: 'En résumé',
  hook: [
    'Aujourd’hui, nous parlons d’un sujet précis : {topic}.',
    'Dans les prochaines minutes, nous allons voir l’essentiel, de façon claire et ordonnée.',
    'À la fin, vous aurez une vue d’ensemble et vous saurez quelle est l’étape suivante.',
  ],
  close: [
    'En résumé, voici l’idée principale du jour : {topic}.',
    'Pour aller plus loin, passez à l’étape suivante et mettez-la en pratique dès cette semaine.',
    'Merci de votre attention.',
  ],
  what: {
    title: 'De quoi s’agit-il',
    headline: 'L’essentiel',
    sentences: [
      'Commençons par la base : de quoi parle-t-on exactement ?',
      'Il est utile d’avoir l’idée centrale en tête avant d’entrer dans les détails.',
      'Avec cette base, tout le reste se comprend beaucoup mieux.',
    ],
  },
  why: {
    title: 'Pourquoi c’est important',
    headline: 'Pourquoi c’est important',
    sentences: [
      'Pourquoi s’y intéresser ? Parce que {it} influence les résultats plus qu’il n’y paraît.',
      'Bien le comprendre fait gagner du temps, évite des erreurs et aide à mieux décider.',
      'L’ignorer, au contraire, finit souvent par coûter cher.',
    ],
  },
  how: {
    title: 'Comment commencer',
    headline: 'Pas à pas',
    sentences: [
      'Comment passer à la pratique ? En trois étapes.',
      'D’abord, définissez votre objectif. Ensuite, commencez par quelque chose de petit et de concret. Enfin, examinez le résultat et ajustez.',
      'Inutile de viser la perfection dès le premier jour : l’important est de commencer.',
    ],
  },
  tip: {
    title: 'Un conseil pratique',
    headline: 'Un conseil',
    sentences: [
      'Un conseil pratique : notez dès le début ce qui fonctionne et ce qui ne fonctionne pas.',
      'Ces notes sont précieuses au moment de s’améliorer.',
    ],
  },
  results: {
    title: 'Ce que vous pouvez attendre',
    headline: 'Résultats',
    sentences: [
      'Que pouvez-vous en attendre ?',
      'Plus de clarté pour décider, moins de temps perdu et des résultats mesurables.',
      'Cela ne se fait pas du jour au lendemain, mais les premiers progrès arrivent vite.',
    ],
  },
  it: 'ce sujet',
  audience: 'Cette vidéo s’adresse à : {audience}.',
  pointLead: 'Point {n} : {point}.',
  pointFillers: [
    'C’est l’un des points clés de {it}.',
    'Gardez-le en tête dès le départ : cela change le résultat final.',
  ],
  sourceHook: 'Aujourd’hui, nous passons en revue les idées principales de : {topic}.',
  partTitle: 'Partie {n}',
  lowerFirst: ['comment', 'pourquoi', 'le', 'la', 'les', 'un', 'une', 'notre', 'nos', 'mon', 'ma'],
});

const DE = neutral({
  hookTitle: 'Einleitung',
  closeTitle: 'Abschluss',
  closeHeadline: 'Kurz gesagt',
  hook: [
    'Heute geht es um ein bestimmtes Thema: {topic}.',
    'In den nächsten Minuten sehen wir uns das Wesentliche an, klar und der Reihe nach.',
    'Am Ende haben Sie den Überblick und wissen, was der nächste Schritt ist.',
  ],
  close: [
    'Zusammengefasst ist das die wichtigste Idee von heute: {topic}.',
    'Wenn Sie tiefer einsteigen möchten, setzen Sie den nächsten Schritt noch diese Woche um.',
    'Vielen Dank für Ihre Aufmerksamkeit.',
  ],
  what: {
    title: 'Worum es geht',
    headline: 'Das Wesentliche',
    sentences: [
      'Beginnen wir mit den Grundlagen: Worum geht es genau?',
      'Es hilft, die zentrale Idee zu kennen, bevor wir ins Detail gehen.',
      'Mit dieser Grundlage ist alles Weitere viel leichter zu verstehen.',
    ],
  },
  why: {
    title: 'Warum es wichtig ist',
    headline: 'Warum es wichtig ist',
    sentences: [
      'Warum lohnt sich die Aufmerksamkeit? Weil {it} die Ergebnisse stärker beeinflusst, als es scheint.',
      'Wer es gut versteht, spart Zeit, vermeidet Fehler und entscheidet besser.',
      'Es zu ignorieren wird dagegen meist teuer.',
    ],
  },
  how: {
    title: 'So fangen Sie an',
    headline: 'Schritt für Schritt',
    sentences: [
      'Wie setzt man es um? In drei Schritten.',
      'Erstens: Legen Sie fest, was Sie erreichen wollen. Zweitens: Beginnen Sie mit etwas Kleinem und Konkretem. Drittens: Prüfen Sie das Ergebnis und passen Sie es an.',
      'Es muss am ersten Tag nicht perfekt sein: Wichtig ist, anzufangen.',
    ],
  },
  tip: {
    title: 'Ein praktischer Tipp',
    headline: 'Ein Tipp',
    sentences: [
      'Ein praktischer Tipp: Notieren Sie von Anfang an, was funktioniert und was nicht.',
      'Diese Notizen sind Gold wert, wenn es ans Verbessern geht.',
    ],
  },
  results: {
    title: 'Was Sie erwarten können',
    headline: 'Ergebnisse',
    sentences: [
      'Was können Sie erwarten?',
      'Mehr Klarheit bei Entscheidungen, weniger verlorene Zeit und messbare Ergebnisse.',
      'Das geschieht nicht über Nacht, aber die ersten Fortschritte kommen schnell.',
    ],
  },
  it: 'dieses Thema',
  audience: 'Dieses Video richtet sich an: {audience}.',
  pointLead: 'Punkt {n}: {point}.',
  pointFillers: [
    'Das ist einer der wichtigsten Punkte.',
    'Behalten Sie ihn von Anfang an im Blick: Er verändert das Endergebnis.',
  ],
  sourceHook: 'Heute gehen wir die wichtigsten Ideen durch von: {topic}.',
  partTitle: 'Teil {n}',
  lowerFirst: [],
});

const IT = neutral({
  hookTitle: 'Introduzione',
  closeTitle: 'Conclusione',
  closeHeadline: 'In sintesi',
  hook: [
    'Oggi parliamo di un argomento preciso: {topic}.',
    'Nei prossimi minuti vedremo l’essenziale, in modo chiaro e ordinato.',
    'Alla fine avrai una visione completa e saprai qual è il passo successivo.',
  ],
  close: [
    'In sintesi, questa è l’idea principale di oggi: {topic}.',
    'Se vuoi approfondire, fai il passo successivo e mettilo in pratica già questa settimana.',
    'Grazie per l’attenzione.',
  ],
  what: {
    title: 'Di cosa si tratta',
    headline: 'L’essenziale',
    sentences: [
      'Cominciamo dalle basi: di che cosa parliamo esattamente?',
      'Conviene avere chiara l’idea centrale prima di entrare nei dettagli.',
      'Con questa base, tutto il resto si capisce molto meglio.',
    ],
  },
  why: {
    title: 'Perché è importante',
    headline: 'Perché è importante',
    sentences: [
      'Perché merita la tua attenzione? Perché {it} incide sui risultati più di quanto sembri.',
      'Capirlo bene fa risparmiare tempo, evita errori e aiuta a decidere meglio.',
      'Ignorarlo, invece, di solito costa caro.',
    ],
  },
  how: {
    title: 'Come iniziare',
    headline: 'Passo dopo passo',
    sentences: [
      'Come si mette in pratica? In tre passi.',
      'Primo, definisci che cosa vuoi ottenere. Secondo, comincia da qualcosa di piccolo e concreto. Terzo, controlla il risultato e correggi.',
      'Non serve farlo alla perfezione il primo giorno: l’importante è cominciare.',
    ],
  },
  tip: {
    title: 'Un consiglio pratico',
    headline: 'Un consiglio',
    sentences: [
      'Un consiglio pratico: annota fin dall’inizio ciò che funziona e ciò che non funziona.',
      'Quegli appunti valgono oro quando arriva il momento di migliorare.',
    ],
  },
  results: {
    title: 'Che cosa aspettarsi',
    headline: 'Risultati',
    sentences: [
      'Che cosa puoi aspettarti in cambio?',
      'Più chiarezza nelle decisioni, meno tempo perso e risultati misurabili.',
      'Non succede da un giorno all’altro, ma i primi progressi arrivano presto.',
    ],
  },
  it: 'questo argomento',
  audience: 'Questo video è pensato per: {audience}.',
  pointLead: 'Punto {n}: {point}.',
  pointFillers: [
    'È uno dei punti chiave.',
    'Tienilo presente fin dall’inizio: fa la differenza nel risultato finale.',
  ],
  sourceHook: 'Oggi ripassiamo le idee principali di: {topic}.',
  partTitle: 'Parte {n}',
  lowerFirst: [
    'come',
    'perché',
    'il',
    'la',
    'lo',
    'i',
    'le',
    'gli',
    'un',
    'una',
    'nostro',
    'nostra',
  ],
});

const PT = neutral({
  hookTitle: 'Introdução',
  closeTitle: 'Encerramento',
  closeHeadline: 'Em resumo',
  hook: [
    'Hoje falamos de um tema concreto: {topic}.',
    'Nos próximos minutos vamos ver o essencial, de forma clara e ordenada.',
    'No final você terá uma visão completa e saberá qual é o próximo passo.',
  ],
  close: [
    'Em resumo, esta é a ideia principal de hoje: {topic}.',
    'Se quiser se aprofundar, dê o próximo passo e coloque em prática ainda esta semana.',
    'Obrigado pela atenção.',
  ],
  what: {
    title: 'O que é',
    headline: 'O essencial',
    sentences: [
      'Vamos começar pelo básico: do que estamos falando exatamente?',
      'Convém ter clara a ideia central antes de entrar nos detalhes.',
      'Com essa base, todo o resto fica muito mais fácil de entender.',
    ],
  },
  why: {
    title: 'Por que importa',
    headline: 'Por que importa',
    sentences: [
      'Por que merece a sua atenção? Porque {it} influencia os resultados mais do que parece.',
      'Entender bem economiza tempo, evita erros e ajuda a decidir melhor.',
      'Ignorar, por outro lado, costuma sair caro.',
    ],
  },
  how: {
    title: 'Como começar',
    headline: 'Passo a passo',
    sentences: [
      'Como colocar em prática? Em três passos.',
      'Primeiro, defina o que você quer alcançar. Segundo, comece por algo pequeno e concreto. Terceiro, revise o resultado e ajuste.',
      'Não precisa ficar perfeito no primeiro dia: o importante é começar.',
    ],
  },
  tip: {
    title: 'Uma dica prática',
    headline: 'Uma dica',
    sentences: [
      'Uma dica prática: anote desde o início o que funciona e o que não funciona.',
      'Essas anotações valem ouro na hora de melhorar.',
    ],
  },
  results: {
    title: 'O que esperar',
    headline: 'Resultados',
    sentences: [
      'O que você pode esperar em troca?',
      'Mais clareza para decidir, menos tempo perdido e resultados que podem ser medidos.',
      'Não acontece de um dia para o outro, mas os primeiros avanços chegam logo.',
    ],
  },
  it: 'este tema',
  audience: 'Este vídeo foi pensado para: {audience}.',
  pointLead: 'Ponto {n}: {point}.',
  pointFillers: [
    'É um dos pontos-chave.',
    'Tenha isso em mente desde o início: faz diferença no resultado final.',
  ],
  sourceHook: 'Hoje revisamos as ideias principais de: {topic}.',
  partTitle: 'Parte {n}',
  lowerFirst: ['como', 'por', 'o', 'a', 'os', 'as', 'um', 'uma', 'nosso', 'nossa'],
});

const CA = neutral({
  hookTitle: 'Introducció',
  closeTitle: 'Tancament',
  closeHeadline: 'En resum',
  hook: [
    'Avui parlem d’un tema concret: {topic}.',
    'En els pròxims minuts repassarem l’essencial, de manera clara i ordenada.',
    'En acabar tindràs una visió completa i sabràs quin és el pas següent.',
  ],
  close: [
    'En resum, aquesta és la idea principal d’avui: {topic}.',
    'Si vols aprofundir-hi, fes el pas següent i posa-ho en pràctica aquesta mateixa setmana.',
    'Gràcies per la teva atenció.',
  ],
  what: {
    title: 'Què és',
    headline: 'L’essencial',
    sentences: [
      'Comencem pel més bàsic: de què parlem exactament?',
      'Convé tenir clara la idea central abans d’entrar en els detalls.',
      'Amb aquesta base, tota la resta s’entén molt millor.',
    ],
  },
  why: {
    title: 'Per què importa',
    headline: 'Per què importa',
    sentences: [
      'Per què mereix la teva atenció? Perquè {it} influeix en els resultats més del que sembla.',
      'Entendre-ho bé estalvia temps, evita errors i ajuda a decidir millor.',
      'Ignorar-ho, en canvi, acostuma a sortir car.',
    ],
  },
  how: {
    title: 'Com començar',
    headline: 'Pas a pas',
    sentences: [
      'Com es posa en pràctica? En tres passos.',
      'Primer, defineix què vols aconseguir. Segon, comença per alguna cosa petita i concreta. Tercer, revisa el resultat i ajusta.',
      'No cal fer-ho perfecte el primer dia: l’important és començar.',
    ],
  },
  tip: {
    title: 'Un consell pràctic',
    headline: 'Un consell',
    sentences: [
      'Un consell pràctic: apunta des del principi què funciona i què no.',
      'Aquests apunts valen or quan toca millorar.',
    ],
  },
  results: {
    title: 'Què pots esperar',
    headline: 'Resultats',
    sentences: [
      'Què en pots esperar a canvi?',
      'Més claredat per decidir, menys temps perdut i resultats que es poden mesurar.',
      'No passa d’un dia per l’altre, però els primers avenços arriben aviat.',
    ],
  },
  it: 'aquest tema',
  audience: 'Aquest vídeo està pensat per a: {audience}.',
  pointLead: 'Punt {n}: {point}.',
  pointFillers: [
    'És un dels punts clau.',
    'Tingues-ho present des del principi: marca la diferència en el resultat final.',
  ],
  sourceHook: 'Avui repassem les idees principals de: {topic}.',
  partTitle: 'Part {n}',
  lowerFirst: ['com', 'per', 'el', 'la', 'els', 'les', 'un', 'una', 'nostre', 'nostra'],
});

const NL = neutral({
  hookTitle: 'Inleiding',
  closeTitle: 'Afsluiting',
  closeHeadline: 'Kort samengevat',
  hook: [
    'Vandaag hebben we het over één onderwerp: {topic}.',
    'In de komende minuten lopen we de hoofdzaken door, helder en stap voor stap.',
    'Aan het eind heb je het overzicht en weet je wat de volgende stap is.',
  ],
  close: [
    'Samengevat is dit het belangrijkste idee van vandaag: {topic}.',
    'Wil je verder gaan? Zet dan deze week nog de volgende stap.',
    'Bedankt voor je aandacht.',
  ],
  what: {
    title: 'Wat het is',
    headline: 'De kern',
    sentences: [
      'Laten we bij de basis beginnen: waar hebben we het precies over?',
      'Het helpt om het kernidee helder te hebben voordat we op de details ingaan.',
      'Met die basis is de rest veel makkelijker te volgen.',
    ],
  },
  why: {
    title: 'Waarom het belangrijk is',
    headline: 'Waarom het telt',
    sentences: [
      'Waarom verdient het je aandacht? Omdat {it} de resultaten sterker beïnvloedt dan het lijkt.',
      'Wie het goed begrijpt, bespaart tijd, voorkomt fouten en beslist beter.',
      'Het negeren kost op termijn meestal veel.',
    ],
  },
  how: {
    title: 'Hoe je begint',
    headline: 'Stap voor stap',
    sentences: [
      'Hoe breng je het in de praktijk? In drie stappen.',
      'Eén: bepaal wat je wilt bereiken. Twee: begin met iets kleins en concreets. Drie: bekijk het resultaat en stuur bij.',
      'Het hoeft op dag één niet perfect te zijn: beginnen is het belangrijkste.',
    ],
  },
  tip: {
    title: 'Een praktische tip',
    headline: 'Eén tip',
    sentences: [
      'Een praktische tip: schrijf vanaf het begin op wat werkt en wat niet.',
      'Die aantekeningen zijn goud waard als je wilt verbeteren.',
    ],
  },
  results: {
    title: 'Wat je kunt verwachten',
    headline: 'Resultaten',
    sentences: [
      'Wat kun je ervan verwachten?',
      'Meer duidelijkheid bij beslissingen, minder verloren tijd en meetbare resultaten.',
      'Het gebeurt niet van de ene op de andere dag, maar de eerste vooruitgang komt snel.',
    ],
  },
  it: 'dit onderwerp',
  audience: 'Deze video is bedoeld voor: {audience}.',
  pointLead: 'Punt {n}: {point}.',
  pointFillers: [
    'Dit is een van de belangrijkste punten.',
    'Houd het vanaf het begin in gedachten: het maakt verschil in het eindresultaat.',
  ],
  sourceHook: 'Vandaag lopen we de belangrijkste ideeën door van: {topic}.',
  partTitle: 'Deel {n}',
  lowerFirst: ['hoe', 'waarom', 'de', 'het', 'een', 'onze', 'ons', 'mijn'],
});

const PL = neutral({
  hookTitle: 'Wprowadzenie',
  closeTitle: 'Zakończenie',
  closeHeadline: 'W skrócie',
  hook: [
    'Dzisiejszy temat to: {topic}.',
    'W ciągu kilku minut omówimy najważniejsze kwestie, jasno i po kolei.',
    'Na koniec będziesz mieć pełny obraz i wiedzieć, jaki jest następny krok.',
  ],
  close: [
    'Podsumowując, główna myśl dzisiejszego filmu to: {topic}.',
    'Jeśli chcesz dowiedzieć się więcej, zrób kolejny krok jeszcze w tym tygodniu.',
    'Dziękujemy za uwagę.',
  ],
  what: {
    title: 'O co chodzi',
    headline: 'Najważniejsze',
    sentences: [
      'Zacznijmy od podstaw: o czym dokładnie mówimy?',
      'Warto dobrze zrozumieć główną ideę, zanim przejdziemy do szczegółów.',
      'Z taką podstawą wszystko inne jest znacznie łatwiejsze do zrozumienia.',
    ],
  },
  why: {
    title: 'Dlaczego to ważne',
    headline: 'Dlaczego to ważne',
    sentences: [
      'Dlaczego warto poświęcić temu uwagę? Bo wpływa to na wyniki bardziej, niż się wydaje.',
      'Dobre zrozumienie oszczędza czas, pozwala uniknąć błędów i pomaga lepiej decydować.',
      'Zignorowanie tego zwykle sporo kosztuje.',
    ],
  },
  how: {
    title: 'Jak zacząć',
    headline: 'Krok po kroku',
    sentences: [
      'Jak zastosować to w praktyce? W trzech krokach.',
      'Po pierwsze, określ, co chcesz osiągnąć. Po drugie, zacznij od czegoś małego i konkretnego. Po trzecie, sprawdź wynik i wprowadź poprawki.',
      'Nie musi być idealnie pierwszego dnia: najważniejsze to zacząć.',
    ],
  },
  tip: {
    title: 'Praktyczna wskazówka',
    headline: 'Wskazówka',
    sentences: [
      'Praktyczna wskazówka: od początku zapisuj, co działa, a co nie.',
      'Te notatki są bezcenne, gdy przychodzi czas na ulepszenia.',
    ],
  },
  results: {
    title: 'Czego się spodziewać',
    headline: 'Efekty',
    sentences: [
      'Czego możesz się spodziewać?',
      'Większej jasności przy podejmowaniu decyzji, mniej straconego czasu i mierzalnych wyników.',
      'Nie stanie się to z dnia na dzień, ale pierwsze postępy przychodzą szybko.',
    ],
  },
  it: 'ten temat',
  audience: 'Ten film jest przeznaczony dla: {audience}.',
  pointLead: 'Punkt {n}: {point}.',
  pointFillers: [
    'To jeden z kluczowych punktów.',
    'Pamiętaj o nim od początku: ma wpływ na końcowy wynik.',
  ],
  sourceHook: 'Dziś omawiamy najważniejsze myśli z: {topic}.',
  partTitle: 'Część {n}',
  lowerFirst: [],
});

const SV = neutral({
  hookTitle: 'Inledning',
  closeTitle: 'Avslutning',
  closeHeadline: 'Kort sagt',
  hook: [
    'I dag handlar det om ett ämne: {topic}.',
    'Under de närmaste minuterna går vi igenom det viktigaste, tydligt och i tur och ordning.',
    'När vi är klara har du helhetsbilden och vet vad nästa steg är.',
  ],
  close: [
    'Sammanfattningsvis är detta dagens huvudidé: {topic}.',
    'Vill du fördjupa dig? Ta nästa steg redan den här veckan.',
    'Tack för din uppmärksamhet.',
  ],
  what: {
    title: 'Vad det är',
    headline: 'Det viktigaste',
    sentences: [
      'Låt oss börja med grunderna: vad är det egentligen vi pratar om?',
      'Det hjälper att ha huvudidén klar innan vi går in på detaljerna.',
      'Med den grunden blir allt annat mycket lättare att förstå.',
    ],
  },
  why: {
    title: 'Varför det är viktigt',
    headline: 'Varför det är viktigt',
    sentences: [
      'Varför förtjänar det din uppmärksamhet? För att det påverkar resultaten mer än man tror.',
      'Att förstå det väl sparar tid, förebygger misstag och leder till bättre beslut.',
      'Att strunta i det brukar däremot bli dyrt.',
    ],
  },
  how: {
    title: 'Så kommer du igång',
    headline: 'Steg för steg',
    sentences: [
      'Hur gör man i praktiken? I tre steg.',
      'Först bestämmer du vad du vill uppnå. Sedan börjar du med något litet och konkret. Till sist granskar du resultatet och justerar.',
      'Det behöver inte bli perfekt första dagen: det viktiga är att börja.',
    ],
  },
  tip: {
    title: 'Ett praktiskt tips',
    headline: 'Ett tips',
    sentences: [
      'Ett praktiskt tips: skriv redan från början upp vad som fungerar och vad som inte gör det.',
      'De anteckningarna är guld värda när det är dags att förbättra.',
    ],
  },
  results: {
    title: 'Vad du kan förvänta dig',
    headline: 'Resultat',
    sentences: [
      'Vad kan du förvänta dig?',
      'Tydligare beslut, mindre bortkastad tid och resultat som går att mäta.',
      'Det sker inte över en natt, men de första framstegen kommer snabbt.',
    ],
  },
  it: 'det här ämnet',
  audience: 'Den här videon är gjord för: {audience}.',
  pointLead: 'Punkt {n}: {point}.',
  pointFillers: [
    'Det är en av de viktigaste punkterna.',
    'Ha den i åtanke från början: den påverkar slutresultatet.',
  ],
  sourceHook: 'I dag går vi igenom huvudidéerna i: {topic}.',
  partTitle: 'Del {n}',
  lowerFirst: ['hur', 'varför', 'en', 'ett', 'vår', 'vårt', 'min'],
});

const TR = neutral({
  hookTitle: 'Giriş',
  closeTitle: 'Kapanış',
  closeHeadline: 'Özetle',
  hook: [
    'Bugünkü konumuz: {topic}.',
    'Önümüzdeki birkaç dakikada en önemli noktaları açık ve sırayla ele alacağız.',
    'Sonunda konunun bütününü görmüş ve bir sonraki adımı öğrenmiş olacaksınız.',
  ],
  close: [
    'Özetle, bugünün ana fikri şu: {topic}.',
    'Daha fazlasını öğrenmek isterseniz, bir sonraki adımı bu hafta içinde atın.',
    'İlginiz için teşekkür ederiz.',
  ],
  what: {
    title: 'Nedir',
    headline: 'Temel bilgiler',
    sentences: [
      'Temelden başlayalım: tam olarak neden söz ediyoruz?',
      'Ayrıntılara girmeden önce ana fikri netleştirmek faydalı olur.',
      'Bu temel ile geri kalan her şeyi anlamak çok daha kolaydır.',
    ],
  },
  why: {
    title: 'Neden önemli',
    headline: 'Neden önemli',
    sentences: [
      'Neden ilginizi hak ediyor? Çünkü sonuçları göründüğünden daha fazla etkiler.',
      'Konuyu iyi anlamak zaman kazandırır, hataları önler ve daha iyi karar vermeyi sağlar.',
      'Görmezden gelmek ise genellikle pahalıya mal olur.',
    ],
  },
  how: {
    title: 'Nasıl başlanır',
    headline: 'Adım adım',
    sentences: [
      'Uygulamaya nasıl geçilir? Üç adımda.',
      'Önce neyi başarmak istediğinizi belirleyin. Sonra küçük ve somut bir şeyle başlayın. Son olarak sonucu gözden geçirin ve düzeltin.',
      'İlk gün mükemmel olması gerekmez: önemli olan başlamaktır.',
    ],
  },
  tip: {
    title: 'Pratik bir ipucu',
    headline: 'Bir ipucu',
    sentences: [
      'Pratik bir ipucu: neyin işe yarayıp neyin yaramadığını en baştan not edin.',
      'Bu notlar, iyileştirme zamanı geldiğinde çok değerlidir.',
    ],
  },
  results: {
    title: 'Ne beklemelisiniz',
    headline: 'Sonuçlar',
    sentences: [
      'Karşılığında ne bekleyebilirsiniz?',
      'Daha net kararlar, daha az kaybedilen zaman ve ölçülebilir sonuçlar.',
      'Bir günde olmaz, ama ilk gelişmeler hızlı gelir.',
    ],
  },
  it: 'bu konu',
  audience: 'Bu video şu kitle için hazırlandı: {audience}.',
  pointLead: '{n}. nokta: {point}.',
  pointFillers: [
    'Bu, en önemli noktalardan biridir.',
    'Baştan itibaren aklınızda tutun: nihai sonucu etkiler.',
  ],
  sourceHook: 'Bugün şu içeriğin ana fikirlerini gözden geçiriyoruz: {topic}.',
  partTitle: 'Bölüm {n}',
  lowerFirst: [],
});

const RU = neutral({
  hookTitle: 'Введение',
  closeTitle: 'Заключение',
  closeHeadline: 'Коротко',
  hook: [
    'Тема сегодняшнего видео: {topic}.',
    'За несколько минут мы разберём самое главное, ясно и по порядку.',
    'В конце у вас будет полная картина и понимание, каким должен быть следующий шаг.',
  ],
  close: [
    'Подведём итог. Главная мысль сегодняшнего видео: {topic}.',
    'Если хотите узнать больше, сделайте следующий шаг уже на этой неделе.',
    'Спасибо за внимание.',
  ],
  what: {
    title: 'Что это такое',
    headline: 'Главное',
    sentences: [
      'Начнём с основ: о чём именно идёт речь?',
      'Полезно понять главную идею, прежде чем переходить к деталям.',
      'С такой основой всё остальное понять гораздо легче.',
    ],
  },
  why: {
    title: 'Почему это важно',
    headline: 'Почему это важно',
    sentences: [
      'Почему на это стоит обратить внимание? Потому что это влияет на результат сильнее, чем кажется.',
      'Хорошее понимание экономит время, помогает избежать ошибок и принимать лучшие решения.',
      'А если этим пренебречь, обычно приходится дорого платить.',
    ],
  },
  how: {
    title: 'С чего начать',
    headline: 'Шаг за шагом',
    sentences: [
      'Как применить это на практике? В три шага.',
      'Во-первых, определите, чего вы хотите добиться. Во-вторых, начните с чего-то небольшого и конкретного. В-третьих, оцените результат и внесите поправки.',
      'Не обязательно делать всё идеально в первый же день: главное начать.',
    ],
  },
  tip: {
    title: 'Практический совет',
    headline: 'Совет',
    sentences: [
      'Практический совет: с самого начала записывайте, что работает, а что нет.',
      'Эти записи очень пригодятся, когда придёт время улучшать.',
    ],
  },
  results: {
    title: 'Чего ожидать',
    headline: 'Результаты',
    sentences: [
      'Чего можно ожидать?',
      'Больше ясности в решениях, меньше потерянного времени и измеримые результаты.',
      'Это происходит не за один день, но первые успехи приходят быстро.',
    ],
  },
  it: 'эта тема',
  audience: 'Это видео предназначено для следующей аудитории: {audience}.',
  pointLead: 'Пункт {n}: {point}.',
  pointFillers: [
    'Это один из ключевых моментов.',
    'Помните о нём с самого начала: он влияет на итоговый результат.',
  ],
  sourceHook: 'Сегодня мы разберём основные идеи материала: {topic}.',
  partTitle: 'Часть {n}',
  lowerFirst: [],
});

const EL = neutral({
  hookTitle: 'Εισαγωγή',
  closeTitle: 'Κλείσιμο',
  closeHeadline: 'Με λίγα λόγια',
  hook: [
    'Το σημερινό μας θέμα είναι: {topic}.',
    'Στα επόμενα λεπτά θα δούμε τα βασικά, με σαφήνεια και με τη σειρά.',
    'Στο τέλος θα έχετε μια πλήρη εικόνα και θα ξέρετε ποιο είναι το επόμενο βήμα.',
  ],
  close: [
    'Συνοψίζοντας, η κύρια ιδέα του σημερινού βίντεο είναι: {topic}.',
    'Αν θέλετε να μάθετε περισσότερα, κάντε το επόμενο βήμα μέσα σε αυτή την εβδομάδα.',
    'Ευχαριστούμε για την προσοχή σας.',
  ],
  what: {
    title: 'Τι είναι',
    headline: 'Τα βασικά',
    sentences: [
      'Ας ξεκινήσουμε από τα βασικά: για τι ακριβώς μιλάμε;',
      'Βοηθά να είναι ξεκάθαρη η κεντρική ιδέα πριν μπούμε στις λεπτομέρειες.',
      'Με αυτή τη βάση, όλα τα υπόλοιπα γίνονται πολύ πιο κατανοητά.',
    ],
  },
  why: {
    title: 'Γιατί έχει σημασία',
    headline: 'Γιατί έχει σημασία',
    sentences: [
      'Γιατί αξίζει την προσοχή σας; Επειδή επηρεάζει τα αποτελέσματα περισσότερο απ’ όσο φαίνεται.',
      'Η καλή κατανόηση εξοικονομεί χρόνο, αποτρέπει λάθη και βοηθά σε καλύτερες αποφάσεις.',
      'Αντίθετα, η αδιαφορία συνήθως κοστίζει ακριβά.',
    ],
  },
  how: {
    title: 'Πώς να ξεκινήσετε',
    headline: 'Βήμα βήμα',
    sentences: [
      'Πώς εφαρμόζεται στην πράξη; Σε τρία βήματα.',
      'Πρώτα, ορίστε τι θέλετε να πετύχετε. Έπειτα, ξεκινήστε από κάτι μικρό και συγκεκριμένο. Τέλος, ελέγξτε το αποτέλεσμα και προσαρμόστε.',
      'Δεν χρειάζεται να είναι τέλειο από την πρώτη μέρα: το σημαντικό είναι να ξεκινήσετε.',
    ],
  },
  tip: {
    title: 'Μια πρακτική συμβουλή',
    headline: 'Μια συμβουλή',
    sentences: [
      'Μια πρακτική συμβουλή: σημειώνετε από την αρχή τι λειτουργεί και τι όχι.',
      'Αυτές οι σημειώσεις είναι πολύτιμες όταν έρθει η ώρα της βελτίωσης.',
    ],
  },
  results: {
    title: 'Τι να περιμένετε',
    headline: 'Αποτελέσματα',
    sentences: [
      'Τι μπορείτε να περιμένετε;',
      'Περισσότερη σαφήνεια στις αποφάσεις, λιγότερο χαμένο χρόνο και μετρήσιμα αποτελέσματα.',
      'Δεν γίνεται από τη μια μέρα στην άλλη, αλλά οι πρώτες βελτιώσεις έρχονται γρήγορα.',
    ],
  },
  it: 'αυτό το θέμα',
  audience: 'Αυτό το βίντεο απευθύνεται σε: {audience}.',
  pointLead: 'Σημείο {n}: {point}.',
  pointFillers: [
    'Είναι ένα από τα βασικά σημεία.',
    'Έχετέ το στον νου σας από την αρχή: επηρεάζει το τελικό αποτέλεσμα.',
  ],
  sourceHook: 'Σήμερα εξετάζουμε τις κύριες ιδέες του: {topic}.',
  partTitle: 'Μέρος {n}',
  lowerFirst: [],
});

export const SCRIPT_PHRASEBOOKS: Record<LanguageCode, ScriptPhrasebook> = {
  es: ES,
  en: EN,
  fr: FR,
  de: DE,
  it: IT,
  pt: PT,
  ca: CA,
  nl: NL,
  pl: PL,
  sv: SV,
  tr: TR,
  ru: RU,
  el: EL,
};

/** Order of the body angles per tone (angles a language lacks are skipped). */
export const TONE_BODY_ORDER: Record<ScriptTone, BodyRole[]> = {
  professional: ['what', 'why', 'how', 'results', 'tip', 'mistakes', 'example'],
  friendly: ['what', 'why', 'tip', 'how', 'example', 'results', 'mistakes'],
  enthusiastic: ['why', 'what', 'how', 'results', 'example', 'tip', 'mistakes'],
  educational: ['what', 'how', 'example', 'tip', 'mistakes', 'why', 'results'],
  persuasive: ['why', 'what', 'results', 'how', 'example', 'mistakes', 'tip'],
  humorous: ['what', 'mistakes', 'why', 'tip', 'how', 'example', 'results'],
};
