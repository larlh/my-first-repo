import { compileTerms, matchesAny, normalizedVariants } from './normalize';

/* -------------------------------------------------------------------------------------------
 * `avatar_prompt` rules: a description must be of a SYNTHETIC adult. This file detects
 *  (a) real, identifiable people — a list of very well known names, unique offices ("the
 *      president of France"), likeness requests ("looks like …", "parecido a …"), full names
 *      introduced as the subject ("portrait of Jane Doe") and people from the user's own life
 *      ("my boss", "mi vecina");
 *  (b) ages under 18.
 * It is a heuristic: an uncommon real name written in lower case with no cue passes. The API
 * states the rule to the user and the engine's licence forbids impersonation as well.
 * ----------------------------------------------------------------------------------------- */

/**
 * Very well known people (politics, entertainment, sport, business, history). Full names, plus
 * single names only when they are unmistakable ("obama", "beyonce") — never when the word is
 * also an ordinary one in a supported language ("maduro" = mature, "franco" = frank, "musk").
 */
const KNOWN_PEOPLE = [
  // politics, current and historical
  'donald trump',
  'trump',
  'joe biden',
  'biden',
  'barack obama',
  'obama',
  'michelle obama',
  'kamala harris',
  'hillary clinton',
  'bill clinton',
  'george bush',
  'george w bush',
  'vladimir putin',
  'putin',
  'volodymyr zelensky',
  'zelensky',
  'zelenski',
  'xi jinping',
  'kim jong un',
  'narendra modi',
  'emmanuel macron',
  'macron',
  'marine le pen',
  'angela merkel',
  'merkel',
  'olaf scholz',
  'friedrich merz',
  'giorgia meloni',
  'silvio berlusconi',
  'pedro sanchez',
  'alberto nuñez feijoo',
  'feijoo',
  'santiago abascal',
  'yolanda diaz',
  'isabel diaz ayuso',
  'ayuso',
  'pablo iglesias',
  'mariano rajoy',
  'rajoy',
  'jose luis rodriguez zapatero',
  'jose maria aznar',
  'aznar',
  'felipe gonzalez',
  'carles puigdemont',
  'puigdemont',
  'felipe vi',
  'rey felipe',
  'juan carlos i',
  'rey juan carlos',
  'reina letizia',
  'letizia ortiz',
  'javier milei',
  'milei',
  'cristina kirchner',
  'cristina fernandez de kirchner',
  'nicolas maduro',
  'hugo chavez',
  'gustavo petro',
  'andres manuel lopez obrador',
  'amlo',
  'claudia sheinbaum',
  'nayib bukele',
  'bukele',
  'gabriel boric',
  'lula da silva',
  'jair bolsonaro',
  'bolsonaro',
  'fidel castro',
  'che guevara',
  'boris johnson',
  'rishi sunak',
  'keir starmer',
  'margaret thatcher',
  'winston churchill',
  'churchill',
  'queen elizabeth',
  'king charles',
  'prince william',
  'prince harry',
  'kate middleton',
  'meghan markle',
  'princess diana',
  'lady di',
  'justin trudeau',
  'benjamin netanyahu',
  'netanyahu',
  'recep tayyip erdogan',
  'erdogan',
  'viktor orban',
  'pope francis',
  'papa francisco',
  'sumo pontifice',
  'pope leo',
  'dalai lama',
  'adolf hitler',
  'hitler',
  'joseph stalin',
  'stalin',
  'benito mussolini',
  'mussolini',
  'francisco franco',
  'mao zedong',
  'osama bin laden',
  'bin laden',
  'saddam hussein',
  'abraham lincoln',
  'john f kennedy',
  'kennedy',
  'martin luther king',
  'nelson mandela',
  'mandela',
  'mahatma gandhi',
  'gandhi',
  'napoleon bonaparte',
  // business and technology
  'elon musk',
  'jeff bezos',
  'bezos',
  'bill gates',
  'steve jobs',
  'mark zuckerberg',
  'zuckerberg',
  'tim cook',
  'sam altman',
  'sundar pichai',
  'satya nadella',
  'warren buffett',
  'amancio ortega',
  'jack ma',
  'oprah winfrey',
  'oprah',
  // music
  'taylor swift',
  'beyonce',
  'rihanna',
  'shakira',
  'madonna',
  'lady gaga',
  'ariana grande',
  'billie eilish',
  'dua lipa',
  'adele',
  'selena gomez',
  'justin bieber',
  'bieber',
  'ed sheeran',
  'harry styles',
  'kanye west',
  'kanye',
  'jay z',
  'eminem',
  'drake',
  'bad bunny',
  'rosalia',
  'karol g',
  'j balvin',
  'daddy yankee',
  'enrique iglesias',
  'julio iglesias',
  'alejandro sanz',
  'david bisbal',
  'jennifer lopez',
  'jlo',
  'britney spears',
  'michael jackson',
  'elvis presley',
  'freddie mercury',
  'john lennon',
  'paul mccartney',
  'bob marley',
  'snoop dogg',
  'cardi b',
  'nicki minaj',
  'miley cyrus',
  'katy perry',
  'bruno mars',
  'the weeknd',
  // film and television
  'leonardo dicaprio',
  'dicaprio',
  'brad pitt',
  'angelina jolie',
  'tom cruise',
  'tom hanks',
  'johnny depp',
  'scarlett johansson',
  'jennifer lawrence',
  'jennifer aniston',
  'emma watson',
  'emma stone',
  'margot robbie',
  'zendaya',
  'timothee chalamet',
  'keanu reeves',
  'will smith',
  'denzel washington',
  'morgan freeman',
  'robert downey jr',
  'chris hemsworth',
  'chris evans',
  'ryan gosling',
  'ryan reynolds',
  'dwayne johnson',
  'arnold schwarzenegger',
  'schwarzenegger',
  'sylvester stallone',
  'meryl streep',
  'nicole kidman',
  'julia roberts',
  'sandra bullock',
  'natalie portman',
  'anne hathaway',
  'gal gadot',
  'ana de armas',
  'penelope cruz',
  'antonio banderas',
  'javier bardem',
  'pedro almodovar',
  'salma hayek',
  'sofia vergara',
  'pedro pascal',
  'marilyn monroe',
  'audrey hepburn',
  'charlie chaplin',
  'kim kardashian',
  'kardashian',
  'kylie jenner',
  'kendall jenner',
  'paris hilton',
  'ellen degeneres',
  'jimmy fallon',
  'joe rogan',
  'mrbeast',
  'mr beast',
  'pewdiepie',
  'ibai llanos',
  'el rubius',
  'auronplay',
  'georgina rodriguez',
  // sport
  'lionel messi',
  'leo messi',
  'messi',
  'cristiano ronaldo',
  'ronaldo',
  'neymar',
  'kylian mbappe',
  'mbappe',
  'erling haaland',
  'haaland',
  'diego maradona',
  'maradona',
  'zinedine zidane',
  'zidane',
  'david beckham',
  'beckham',
  'lamine yamal',
  'vinicius junior',
  'sergio ramos',
  'andres iniesta',
  'pep guardiola',
  'guardiola',
  'rafael nadal',
  'rafa nadal',
  'carlos alcaraz',
  'roger federer',
  'federer',
  'novak djokovic',
  'djokovic',
  'serena williams',
  'lebron james',
  'lebron',
  'michael jordan',
  'kobe bryant',
  'stephen curry',
  'pau gasol',
  'fernando alonso',
  'carlos sainz',
  'lewis hamilton',
  'max verstappen',
  'usain bolt',
  'simone biles',
  'tiger woods',
  'mike tyson',
  'conor mcgregor',
  'muhammad ali',
  'tom brady',
  // science and culture
  'albert einstein',
  'einstein',
  'stephen hawking',
  'greta thunberg',
  'malala yousafzai',
  'frida kahlo',
  'salvador dali',
  'pablo picasso',
  'picasso',
  'j k rowling',
  'jk rowling',
  'stephen king',
];

/** Unique offices and titles: describing their holder describes one identifiable person. */
const OFFICE_HOLDERS = [
  'president of the united states',
  'us president',
  'american president',
  'potus',
  'first lady',
  'the pope',
  'le pape',
  'der papst',
  'presidente de españa',
  'presidente del gobierno',
  'presidenta del gobierno',
  'presidente de estados unidos',
  'presidente de los estados unidos',
  'presidente de mexico',
  'presidenta de mexico',
  'presidente de argentina',
  'presidente de colombia',
  'presidente de chile',
  'presidente de francia',
  'presidente de rusia',
  'presidente de venezuela',
  'rey de españa',
  'reina de españa',
  'king of spain',
  'queen of spain',
  'king of england',
  'queen of england',
  'british prime minister',
  'german chancellor',
  'french president',
  'russian president',
  'president of france',
  'president of russia',
  'president of mexico',
  'president of china',
  'prime minister of',
  'primer ministro de',
  'primera ministra de',
  'chancellor of germany',
  'canciller de alemania',
  'ceo of tesla',
  'ceo of apple',
  'ceo of microsoft',
  'ceo of meta',
  'ceo of amazon',
  'ceo of openai',
  'ceo de tesla',
  'ceo de apple',
  'ceo de microsoft',
  'ceo de meta',
  'ceo de amazon',
];

/** Requests for the likeness of "a celebrity" without naming one. */
const CELEBRITY_WORDS = [
  'celebrity',
  'celebrities',
  'celeb',
  'famous actor',
  'famous actress',
  'famous singer',
  'famous person',
  'famous politician',
  'famous footballer',
  'famous athlete',
  'movie star',
  'film star',
  'pop star',
  'existing person',
  'deepfake*',
  'impersonat*',
  'lookalike*',
  'look alike',
  'doppelganger*',
  'body double',
  'celebridad',
  'celebridades',
  'actor famoso',
  'actriz famosa',
  'cantante famoso',
  'cantante famosa',
  'futbolista famoso',
  'politico famoso',
  'estrella de cine',
  'estrella del pop',
  'persona existente',
  'persona famosa',
  'suplantar*',
  'suplantacion',
  'imitador de',
  'imitadora de',
  'doble de',
  'clon de',
  'sosia',
  'sosie',
  'celebrite',
];

/** People from the requester's own life: real and identifiable to those around them. */
const RELATIONS_EN =
  'boss|manager|wife|husband|spouse|partner|girlfriend|boyfriend|fiancee?|ex|neighbou?r|teacher|' +
  'professor|friend|coworker|co worker|colleague|classmate|roommate|mother|mom|mum|father|dad|sister|' +
  'brother|daughter|son|aunt|uncle|cousin|grandmother|grandma|grandfather|grandpa|niece|nephew|' +
  'landlord|landlady|doctor|client|customer|employee|crush|stepmother|stepfather|mother in law|' +
  'father in law';
const RELATIONS_ES =
  'jefe|jefa|esposa|esposo|mujer|marido|pareja|novia|novio|prometida|prometido|ex|exnovia|exnovio|' +
  'vecino|vecina|profesor|profesora|maestro|maestra|amigo|amiga|compañero|compañera|colega|madre|' +
  'mama|padre|papa|hermana|hermano|hija|hijo|tia|tio|prima|primo|abuela|abuelo|sobrina|sobrino|' +
  'casero|casera|medico|doctora|cliente|clienta|empleado|empleada|suegra|suegro|cuñada|cuñado|' +
  'madrastra|padrastro';

const RELATION_PATTERN = new RegExp(
  `(?:^| )(?:(?:my|our) (?:own |dear |old |former |late |best )?(?:${RELATIONS_EN})|` +
    `(?:mi|mis|nuestro|nuestra) (?:propio |propia |querido |querida |antiguo |antigua |mejor )?(?:${RELATIONS_ES}))(?= |$)`,
  'u',
);

const KNOWN_PEOPLE_MATCHER = compileTerms(KNOWN_PEOPLE);
const OFFICE_MATCHER = compileTerms(OFFICE_HOLDERS);
const CELEBRITY_MATCHER = compileTerms(CELEBRITY_WORDS);

/*
 * Cue + proper name, on the ORIGINAL text (capital letters matter).
 *  - likeness cues take ONE capitalised word: "looks like Shakira", "parecida a Rosalía"
 *  - subject cues take a FULL name (two or more capitalised words): "portrait of Jane Doe",
 *    "llamado Juan Pérez"; a lone first name ("named Ana") only names the fictional presenter.
 */
const UPPER = '\\p{Lu}';
const NAME_WORD = `${UPPER}[\\p{L}'’.-]+`;
const NAME_PARTICLE = '(?:de|del|de la|de los|van|von|da|di|bin|al|la|le|y)';
const FULL_NAME = `${NAME_WORD}(?:\\s+(?:${NAME_PARTICLE}\\s+)?${NAME_WORD})+`;

const LIKENESS_CUES =
  'looks? (?:just |exactly |a lot |a bit )?like|looking (?:just |exactly )?like|resembl(?:es|ing|e)|' +
  'similar to|identical to|the (?:face|likeness|appearance|features) of|face of|likeness of|' +
  'clone of|twin of|dressed as|as if (?:he|she|they) (?:were|was)|' +
  'parecid[oa]s? a|se parece a|se parezca a|que parezca|igual(?:it[oa])? (?:que|a)|idéntic[oa] a|identic[oa] a|' +
  'similar a|como si fuera|la cara de|el rostro de|con la cara de|con el rostro de|' +
  'imitando a|disfrazad[oa] de|' +
  'ressembl(?:e|ant) [àa]|semblable [àa]|sieht aus wie|ähnlich wie|somiglia a|simile a|parecid[oa] com';

const SUBJECT_CUES =
  'portrait of|photo of|picture of|image of|headshot of|avatar of|named|called|known as|' +
  'retrato de|foto de|fotograf[ií]a de|imagen de|avatar de|llamad[oa]|que se llama|conocid[oa] como|' +
  // "in the style of Art Deco" is not a person, "in the style of Frida Kahlo" is: these looser
  // cues need a full name, like the subject cues.
  'inspired by|based on|modell?ed (?:on|after)|in the style of|version of|' +
  'inspirad[oa] en|basad[oa] en|al estilo de|versi[oó]n de|' +
  'señor|señora|sr|sra|mr|mrs|ms|dr|doctor|doctora|don|doña|president[ea]?|senator|senador[a]?|' +
  'minist(?:er|ro|ra)|actor|actress|actriz|singer|cantante|footballer|futbolista|player|jugador[a]?';

const ARTICLE = /^(?:(?:a|an|the|el|la|los|las|un|una|le|les|der|die|das|il|lo|o)\s+)/iu;
const LIKENESS_CUE = new RegExp(`(?:^|[^\\p{L}])(?:${LIKENESS_CUES})\\s+`, 'giu');
const SUBJECT_CUE = new RegExp(`(?:^|[^\\p{L}])(?:${SUBJECT_CUES})\\.?\\s+`, 'giu');
/** Case-SENSITIVE on purpose: only the cues are matched case-insensitively. */
const LEADING_NAME_WORD = new RegExp(`^(${NAME_WORD})`, 'u');
const LEADING_FULL_NAME = new RegExp(`^(${FULL_NAME})`, 'u');

/** Text that follows each occurrence of a cue (without a leading article). */
function* afterCues(text: string, cue: RegExp): Generator<string> {
  for (const match of text.matchAll(cue)) {
    yield text.slice(match.index + match[0].length).replace(ARTICLE, '');
  }
}

/**
 * Capitalised words that are NOT personal names: demonyms, places, languages, brands of
 * clothing styles, months… A cue followed only by these is a generic description
 * ("looks like a Latin American doctor", "al estilo Mediterráneo").
 */
const NOT_A_NAME = new Set(
  [
    'african american asian european latin latina latino hispanic hispana hispano caucasian ' +
      'mediterranean mediterraneo mediterranea nordic scandinavian slavic arab arabic indian ' +
      'chinese japanese korean thai vietnamese filipino filipina mexican mexicana mexicano ' +
      'spanish española español french francesa frances german alemana aleman italian italiana ' +
      'italiano portuguese brazilian brasileña brasileño colombian colombiana colombiano ' +
      'argentinian argentina argentino chilean chilena chileno peruvian peruana peruano ' +
      'venezuelan cuban cubana cubano dominican british english irish scottish welsh dutch ' +
      'swedish norwegian danish finnish polish russian ukrainian greek turkish persian iranian ' +
      'egyptian moroccan marroqui nigerian kenyan ethiopian south north east west middle ' +
      'eastern western southern northern central pacific islander native indigenous america ' +
      'africa asia europe europa oceania caribbean caribe caribeña caribeño andina andino ' +
      'maya mapuche quechua polynesian maori hawaiian canadian australian swiss austrian ' +
      'belgian czech hungarian romanian bulgarian serbian croatian israeli lebanese syrian ' +
      'pakistani bangladeshi nepali sri lankan indonesian malaysian mongolian tibetan ' +
      'i hd k professional studio ceo cto doctor doctora dr ingeniera ingeniero ' +
      // styles, eras and places that follow "in the style of …" without being a person
      'art deco nouveau pop noir film new york los angeles san francisco wall street silicon ' +
      'valley hollywood bollywood vogue renaissance baroque gothic victorian bauhaus national ' +
      'geographic old money business casual smart haute couture belle epoque retro vintage ' +
      'modern classic corporate linkedin tedx ted talk talks',
  ]
    .join(' ')
    .split(/\s+/),
);

function isProperName(candidate: string): boolean {
  const words = candidate
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 1);
  return words.length > 0 && words.some((word) => !NOT_A_NAME.has(word));
}

/**
 * Prompts typed in Title Case or ALL CAPS carry no information in their capitals: the
 * cue + name rules are skipped for them (the name list and the other rules still apply).
 */
function capitalsAreMeaningful(text: string): boolean {
  const words = text.match(/\p{L}{2,}/gu) ?? [];
  if (words.length < 4) return true;
  const capitalised = words.filter((word) => /^\p{Lu}/u.test(word)).length;
  return capitalised / words.length < 0.6;
}

/** True when the description names or points at a real, identifiable person. */
export function describesRealPerson(text: string, variants = normalizedVariants(text)): boolean {
  if (matchesAny(variants, KNOWN_PEOPLE_MATCHER)) return true;
  if (matchesAny(variants, OFFICE_MATCHER)) return true;
  if (matchesAny(variants, CELEBRITY_MATCHER)) return true;
  if (variants.some((variant) => RELATION_PATTERN.test(variant))) return true;
  if (!capitalsAreMeaningful(text)) return false;
  for (const rest of afterCues(text, LIKENESS_CUE)) {
    const name = LEADING_NAME_WORD.exec(rest)?.[1];
    if (name && isProperName(name)) return true;
  }
  for (const rest of afterCues(text, SUBJECT_CUE)) {
    const name = LEADING_FULL_NAME.exec(rest)?.[1];
    if (name && isProperName(name)) return true;
  }
  return false;
}

/** Words after a number of years that make it a duration, not an age. */
const NOT_AN_AGE =
  '(?! (?:en|in|como|as|with|con nosotros|ago|atras|later|despues|mas|trabajando|working|' +
  '(?:de |d |of |di |an )?(?:experiencia|experience|carrera|trayectoria|antiguedad|servicio|oficio|' +
  'profesion|practica|practice|erfahrung|berufserfahrung|esperienza))(?= |$))';
const DURATION_LEAD =
  '(?<!(?:hace|durante|tras|desde hace|despues de|mas de|menos de|casi|lleva|llevo|llevan|llevamos|' +
  'for|after|over|past|last|nearly|almost|than|within|spent|en|in|cada|every) )';

const AGE_PATTERNS: RegExp[] = [
  // "12 years old", "12 year old", "12 yo", "12 años", "12 ans", "12 jahre", "12 anni"
  new RegExp(
    `(?:^| )${DURATION_LEAD}(\\d{1,3}) ?(?:years? old|year olds?|yrs? old|yo|y o|años|anos|añitos|ans|jahre|jahrige[rn]?|anni)${NOT_AN_AGE}(?= |$)`,
    'u',
  ),
  // "aged 12", "age 12", "age of 12", "edad de 12"
  /(?:^| )(?:aged?|age of|edad de|edad|alter von) (\d{1,3})(?= |$)/u,
  // "6 months old", "6 meses"
  new RegExp(
    `(?:^| )${DURATION_LEAD}(\\d{1,3}) ?(?:months? old|meses|mois|monate)${NOT_AN_AGE}(?= |$)`,
    'u',
  ),
];

/**
 * True when the description states an age under 18 ("15 years old", "de 9 años", "aged 16",
 * "6 months old"). Runs on normalised text.
 */
export function statesMinorAge(variants: readonly string[]): boolean {
  for (const variant of variants) {
    for (const [index, pattern] of AGE_PATTERNS.entries()) {
      for (const match of variant.matchAll(new RegExp(pattern.source, 'gu'))) {
        if (!match[1]) continue;
        if (index === 2) return true; // an age in months is always a baby
        const age = Number(match[1]);
        if (Number.isFinite(age) && age < 18) return true;
      }
    }
  }
  return false;
}
