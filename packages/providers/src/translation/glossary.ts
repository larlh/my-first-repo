import type { LanguageCode } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Glossary of the local ("modo básico") translator: a few hundred frequent words and phrases
 * of narration scripts. One row = one meaning; columns = languages. A cell may list
 * alternatives separated by `/` — all of them are recognised as source, the FIRST is written
 * as target. An empty cell means "no entry": the source word is left untouched.
 *
 * This is word-for-word substitution: no grammar, no agreement, no word order. It exists so
 * the translation pipeline works offline end to end; real translation needs the Anthropic
 * provider. Everything the glossary does not know stays in the source language.
 * ----------------------------------------------------------------------------------------- */

const MAIN_COLUMNS: LanguageCode[] = ['es', 'en', 'fr', 'de', 'it', 'pt'];

/** es | en | fr | de | it | pt */
const MAIN = `
hola|hello/hi|bonjour/salut|hallo|ciao/salve|olá
buenos días|good morning|bonjour|guten Morgen|buongiorno|bom dia
buenas tardes|good afternoon|bon après-midi|guten Tag|buon pomeriggio|boa tarde
buenas noches|good evening/good night|bonsoir/bonne nuit|guten Abend/gute Nacht|buonasera/buonanotte|boa noite
adiós|goodbye/bye|au revoir|auf Wiedersehen/tschüss|arrivederci|adeus/tchau
hasta pronto|see you soon|à bientôt|bis bald|a presto|até breve/até logo
hasta luego|see you later|à plus tard|bis später|a dopo|até mais
gracias|thank you/thanks|merci|danke|grazie|obrigado/obrigada
muchas gracias|thank you very much/thanks a lot|merci beaucoup|vielen Dank|grazie mille|muito obrigado
de nada|you are welcome/you're welcome|de rien|gern geschehen/bitte|prego|de nada
por favor|please|s'il vous plaît/s'il te plaît|bitte|per favore|por favor
perdón/disculpa|sorry|pardon/désolé|Entschuldigung|scusa/scusi|desculpe
bienvenidos/bienvenido/bienvenida/bienvenidas|welcome|bienvenue|willkommen|benvenuti/benvenuto/benvenuta|bem-vindos/bem-vindo/bem-vinda
sí|yes|oui|ja|sì|sim
no|no/not|non/pas|nein/nicht|no/non|não
y/e|and|et|und|e/ed|e
o/u|or|ou|oder|o|ou
pero|but|mais|aber|ma/però|mas
porque|because|parce que|weil|perché|porque
por eso|that is why/so|c'est pourquoi|deshalb|per questo|por isso
también|also/too|aussi|auch|anche|também
además|in addition/besides|de plus|außerdem|inoltre|além disso
entonces|then|alors|dann|allora|então
si|if|si|wenn/falls|se|se
cuando|when|quand|wann|quando|quando
donde/dónde|where|où|wo|dove|onde
como/cómo|how/like|comment/comme|wie|come|como
qué|what|quoi/que|was|cosa/che|o que
por qué|why|pourquoi|warum|perché|por que
quién|who|qui|wer|chi|quem
cuánto|how much|combien|wie viel|quanto|quanto
con|with|avec|mit|con|com
sin|without|sans|ohne|senza|sem
para|for|pour|für|per|para
por|by|par|durch|da|por
de|of/from|de|von|di|de
en|in|dans/en|in|in|em
a|to|à|zu|a|a
sobre|about|sur|über|su/sopra|sobre
entre|between|entre|zwischen|tra/fra|entre
desde|since|depuis|seit|da|desde
hasta|until|jusqu'à|bis|fino a|até
el/la/los/las|the|le/la/les|der/die/das|il/lo/i/gli/le|o/os/as
un/una|a/an|un/une|ein/eine|un/uno/una|um/uma
este/esta|this|ce/cette|dieser/diese/dieses|questo/questa|este/esta
estos/estas|these|ces|diese|questi/queste|estes/estas
ese/esa/eso|that|cela/ça|das/jener|quello/quella|esse/essa/isso
yo|I|je|ich|io|eu
tú/usted|you|tu/vous|du/Sie|tu/Lei|você/tu
él|he|il|er|lui|ele
ella|she|elle|sie|lei|ela
nosotros/nosotras|we|nous|wir|noi|nós
ellos/ellas|they|ils/elles|sie|loro|eles/elas
mi/mis|my|mon/ma/mes|mein/meine|mio/mia/miei|meu/minha/meus
tu/tus/su/sus|your|ton/ta/tes/votre/vos|dein/deine/Ihr/Ihre|tuo/tua/tuoi/suo/sua|seu/sua/seus/teu
nuestro/nuestra/nuestros/nuestras|our|notre/nos|unser/unsere|nostro/nostra/nostri/nostre|nosso/nossa/nossos/nossas
es|is|est|ist|è|é
son|are|sont|sind|sono|são
soy|I am|je suis|ich bin|io sono|eu sou
somos|we are|nous sommes|wir sind|siamo|somos
está|is located|se trouve|befindet sich|si trova|está
hay|there is/there are|il y a|es gibt|c'è/ci sono|há
tiene|has|a|hat|ha|tem
tienen|have|ont|haben|hanno|têm
tenemos|we have|nous avons|wir haben|abbiamo|temos
puede|can|peut|kann|può|pode
pueden|they can|peuvent|können|possono|podem
podemos|we can|nous pouvons|wir können|possiamo|podemos
puedes|you can|tu peux/vous pouvez|du kannst/Sie können|puoi|você pode
quiere|wants|veut|will/möchte|vuole|quer
queremos|we want|nous voulons|wir wollen/wir möchten|vogliamo|queremos
necesita|needs|a besoin de|braucht|ha bisogno di|precisa
necesitas|you need|vous avez besoin de|Sie brauchen/du brauchst|hai bisogno di|você precisa
vamos a|we are going to/let us|nous allons|wir werden|andiamo a|vamos
hablamos de|we talk about|nous parlons de|wir sprechen über|parliamo di|falamos de
presentamos|we present|nous présentons|wir präsentieren/wir stellen vor|presentiamo|apresentamos
te presentamos|we present to you|nous vous présentons|wir stellen Ihnen vor|ti presentiamo|apresentamos a você
aprender|to learn|apprendre|lernen|imparare|aprender
ver|to see/to watch|voir/regarder|sehen/ansehen|vedere/guardare|ver/assistir
crear|to create|créer|erstellen|creare|criar
usar/utilizar|to use|utiliser|verwenden/benutzen|usare/utilizzare|usar/utilizar
hacer|to do/to make|faire|machen/tun|fare|fazer
empezar/comenzar|to start/to begin|commencer|anfangen/beginnen|iniziare/cominciare|começar
mejorar|to improve|améliorer|verbessern|migliorare|melhorar
ahorrar|to save|économiser|sparen|risparmiare|economizar/poupar
comprar|to buy|acheter|kaufen|comprare|comprar
vender|to sell|vendre|verkaufen|vendere|vender
ayudar|to help|aider|helfen|aiutare|ajudar
saber|to know|savoir|wissen|sapere|saber
funciona|works|fonctionne|funktioniert|funziona|funciona
incluye|includes|comprend/inclut|enthält/umfasst|include|inclui
cuesta|costs|coûte|kostet|costa|custa
vídeo/video|video|vidéo|Video|video|vídeo
vídeos/videos|videos|vidéos|Videos|video|vídeos
producto|product|produit|Produkt|prodotto|produto
productos|products|produits|Produkte|prodotti|produtos
servicio|service|service|Dienst/Service|servizio|serviço
servicios|services|services|Dienste/Dienstleistungen|servizi|serviços
empresa/compañía|company|entreprise/société|Unternehmen/Firma|azienda/società|empresa
equipo|team|équipe|Team|squadra/team|equipe/equipa
cliente|customer/client|client|Kunde|cliente|cliente
clientes|customers/clients|clients|Kunden|clienti|clientes
precio|price|prix|Preis|prezzo|preço
precios|prices|prix|Preise|prezzi|preços
tiempo|time|temps|Zeit|tempo|tempo
día|day|jour|Tag|giorno|dia
días|days|jours|Tage|giorni|dias
semana|week|semaine|Woche|settimana|semana
semanas|weeks|semaines|Wochen|settimane|semanas
mes|month|mois|Monat|mese|mês
meses|months|mois|Monate|mesi|meses
año|year|an/année|Jahr|anno|ano
años|years|ans/années|Jahre|anni|anos
hora|hour|heure|Stunde|ora|hora
horas|hours|heures|Stunden|ore|horas
minuto|minute|minute|Minute|minuto|minuto
minutos|minutes|minutes|Minuten|minuti|minutos
hoy|today|aujourd'hui|heute|oggi|hoje
mañana|tomorrow|demain|morgen|domani|amanhã
ahora|now|maintenant|jetzt|adesso/ora|agora
siempre|always|toujours|immer|sempre|sempre
nunca|never|jamais|nie/niemals|mai|nunca
ya|already|déjà|schon/bereits|già|já
pronto|soon|bientôt|bald|presto|em breve/logo
aquí|here|ici|hier|qui/qua|aqui
allí/ahí|there|là|dort/da|là/lì|ali/lá
muy|very|très|sehr|molto|muito
más|more|plus|mehr|più|mais
menos|less|moins|weniger|meno|menos
mucho/mucha|much/a lot|beaucoup|viel|molto/tanta|muito/muita
muchos/muchas|many|beaucoup de|viele|molti/molte|muitos/muitas
todo/toda|everything/all|tout/toute|alles/ganz|tutto/tutta|tudo/toda
todos/todas|everyone/all of them|tous/toutes|alle|tutti/tutte|todos/todas
nada|nothing|rien|nichts|niente/nulla|nada
algo|something|quelque chose|etwas|qualcosa|algo
nuevo/nueva|new|nouveau/nouvelle|neu/neue|nuovo/nuova|novo/nova
nuevos/nuevas|new ones|nouveaux/nouvelles|neue|nuovi/nuove|novos/novas
bueno/buena|good|bon/bonne|gut/gute|buono/buona|bom/boa
mejor|better/best|meilleur/mieux|besser/beste|migliore/meglio|melhor
grande|big/large|grand/grande|groß/große|grande|grande
pequeño/pequeña|small|petit/petite|klein/kleine|piccolo/piccola|pequeno/pequena
fácil|easy|facile|einfach/leicht|facile|fácil
difícil|difficult/hard|difficile|schwierig/schwer|difficile|difícil
rápido/rápida|fast/quick|rapide|schnell|veloce/rapido|rápido/rápida
importante|important|important/importante|wichtig|importante|importante
gratis/gratuito/gratuita|free|gratuit/gratuite|kostenlos/gratis|gratuito/gratis|grátis/gratuito
disponible|available|disponible|verfügbar|disponibile|disponível
seguro/segura|safe/secure|sûr/sûre|sicher|sicuro/sicura|seguro/segura
primero/primera/primer|first|premier/première|erste/erster/zuerst|primo/prima|primeiro/primeira
segundo/segunda|second|deuxième|zweite/zweiter|secondo/seconda|segundo/segunda
tercero/tercera/tercer|third|troisième|dritte/dritter|terzo/terza|terceiro/terceira
último/última|last|dernier/dernière|letzte/letzter|ultimo/ultima|último/última
siguiente|next|suivant/suivante|nächste/nächster|prossimo/successivo|próximo/seguinte
uno|one|un|eins|uno|um
dos|two|deux|zwei|due|dois
tres|three|trois|drei|tre|três
cuatro|four|quatre|vier|quattro|quatro
cinco|five|cinq|fünf|cinque|cinco
seis|six|six|sechs|sei|seis
siete|seven|sept|sieben|sette|sete
ocho|eight|huit|acht|otto|oito
nueve|nine|neuf|neun|nove|nove
diez|ten|dix|zehn|dieci|dez
persona|person|personne|Person|persona|pessoa
personas/gente|people|personnes/gens|Menschen/Leute|persone/gente|pessoas/gente
mundo|world|monde|Welt|mondo|mundo
trabajo|work/job|travail|Arbeit|lavoro|trabalho
proyecto|project|projet|Projekt|progetto|projeto
curso|course|cours|Kurs|corso|curso
lección|lesson|leçon|Lektion|lezione|lição
ejemplo|example|exemple|Beispiel|esempio|exemplo
por ejemplo|for example|par exemple|zum Beispiel|per esempio/ad esempio|por exemplo
paso|step|étape|Schritt|passo|passo
pasos|steps|étapes|Schritte|passi|passos
paso a paso|step by step|pas à pas/étape par étape|Schritt für Schritt|passo dopo passo|passo a passo
idea|idea|idée|Idee|idea|ideia
ideas|ideas|idées|Ideen|idee|ideias
resultado|result|résultat|Ergebnis|risultato|resultado
resultados|results|résultats|Ergebnisse|risultati|resultados
problema|problem|problème|Problem|problema|problema
solución|solution|solution|Lösung|soluzione|solução
pregunta|question|question|Frage|domanda|pergunta
preguntas|questions|questions|Fragen|domande|perguntas
respuesta|answer|réponse|Antwort|risposta|resposta
información|information|information/informations|Information/Informationen|informazione/informazioni|informação
datos|data|données|Daten|dati|dados
cuenta|account|compte|Konto|account/conto|conta
plan|plan|plan/forfait|Plan/Tarif|piano|plano
oferta|offer|offre|Angebot|offerta|oferta
calidad|quality|qualité|Qualität|qualità|qualidade
seguridad|security/safety|sécurité|Sicherheit|sicurezza|segurança
formación|training|formation|Schulung/Ausbildung|formazione|formação/treinamento
novedades|news/what is new|nouveautés|Neuigkeiten|novità|novidades
consejo|tip|conseil|Tipp|consiglio|dica
consejos|tips|conseils|Tipps|consigli|dicas
guía|guide|guide|Leitfaden/Anleitung|guida|guia
tema|topic/subject|sujet/thème|Thema|argomento/tema|tema/assunto
parte|part|partie|Teil|parte|parte
introducción|introduction|introduction|Einführung/Einleitung|introduzione|introdução
resumen|summary|résumé|Zusammenfassung|riassunto/sintesi|resumo
en resumen|in summary/to sum up|en résumé|zusammengefasst/kurz gesagt|in sintesi/riassumendo|em resumo
ventajas|advantages|avantages|Vorteile|vantaggi|vantagens
beneficios|benefits|bénéfices/avantages|Nutzen/Vorteile|benefici|benefícios
ahorro|savings|économies|Ersparnis|risparmio|economia/poupança
dinero|money|argent|Geld|denaro/soldi|dinheiro
casa/hogar|home/house|maison|Haus/Zuhause|casa|casa/lar
ciudad|city|ville|Stadt|città|cidade
país|country|pays|Land|paese|país
energía|energy|énergie|Energie|energia|energia
agua|water|eau|Wasser|acqua|água
salud|health|santé|Gesundheit|salute|saúde
vida|life|vie|Leben|vita|vida
familia|family|famille|Familie|famiglia|família
amigos|friends|amis|Freunde|amici|amigos
niños|children|enfants|Kinder|bambini|crianças
aplicación/app|app/application|application/appli|App/Anwendung|applicazione/app|aplicativo/aplicação/app
página|page|page|Seite|pagina|página
sitio web/web|website|site web|Website/Webseite|sito web|site
correo electrónico/correo|email|e-mail/courriel|E-Mail|e-mail/posta elettronica|e-mail
teléfono|phone|téléphone|Telefon|telefono|telefone
contraseña|password|mot de passe|Passwort|password|senha
usuario|user|utilisateur|Benutzer|utente|usuário/utilizador
usuarios|users|utilisateurs|Benutzer|utenti|usuários/utilizadores
botón|button|bouton|Schaltfläche/Knopf|pulsante|botão
enlace|link|lien|Link|link/collegamento|link
haz clic/pulsa|click|cliquez|klicken Sie|clicca|clique
suscríbete|subscribe|abonnez-vous|abonnieren Sie|iscriviti|inscreva-se
regístrate|sign up|inscrivez-vous|registrieren Sie sich|registrati|cadastre-se/registe-se
descubre|discover|découvrez|entdecken Sie|scopri|descubra
empieza hoy|start today|commencez aujourd'hui|fangen Sie heute an|inizia oggi|comece hoje
gracias por ver este vídeo|thank you for watching this video/thanks for watching|merci d'avoir regardé cette vidéo|danke fürs Zuschauen|grazie per aver guardato questo video|obrigado por assistir a este vídeo
gracias por tu atención/gracias por su atención|thank you for your attention|merci de votre attention|vielen Dank für Ihre Aufmerksamkeit|grazie per l'attenzione|obrigado pela atenção
nos vemos en el próximo vídeo|see you in the next video|rendez-vous dans la prochaine vidéo|bis zum nächsten Video|ci vediamo al prossimo video|vemo-nos no próximo vídeo/até o próximo vídeo
en este vídeo|in this video|dans cette vidéo|in diesem Video|in questo video|neste vídeo
hoy hablamos de|today we talk about|aujourd'hui nous parlons de|heute sprechen wir über|oggi parliamo di|hoje falamos de
lo más importante|the most important thing|le plus important|das Wichtigste|la cosa più importante|o mais importante
`;

const CORE_COLUMNS: LanguageCode[] = [
  'es',
  'en',
  'fr',
  'de',
  'it',
  'pt',
  'ca',
  'nl',
  'pl',
  'sv',
  'tr',
  'ru',
  'el',
];

/** A core of everyday words for every supported language (same column order as above). */
const CORE = `
hola|hello|bonjour|hallo|ciao|olá|hola|hallo|cześć|hej|merhaba|привет|γεια
gracias|thank you|merci|danke|grazie|obrigado|gràcies|dank je/bedankt|dziękuję|tack|teşekkürler|спасибо|ευχαριστώ
adiós|goodbye|au revoir|auf Wiedersehen|arrivederci|adeus|adeu|tot ziens|do widzenia|hej då|hoşça kal|до свидания|αντίο
sí|yes|oui|ja|sì|sim|sí|ja|tak|ja|evet|да|ναι
no|no|non|nein|no|não|no|nee|nie|nej|hayır|нет|όχι
por favor|please|s'il vous plaît|bitte|per favore|por favor|si us plau|alsjeblieft|proszę|snälla|lütfen|пожалуйста|παρακαλώ
bienvenidos|welcome|bienvenue|willkommen|benvenuti|bem-vindos|benvinguts|welkom|witamy|välkommen|hoş geldiniz|добро пожаловать|καλώς ήρθατε
y|and|et|und|e|e|i|en|i|och|ve|и|και
o|or|ou|oder|o|ou|o|of|lub|eller|veya|или|ή
pero|but|mais|aber|ma|mas|però|maar|ale|men|ama|но|αλλά
hoy|today|aujourd'hui|heute|oggi|hoje|avui|vandaag|dzisiaj|i dag|bugün|сегодня|σήμερα
ahora|now|maintenant|jetzt|adesso|agora|ara|nu|teraz|nu|şimdi|сейчас|τώρα
vídeo|video|vidéo|Video|video|vídeo|vídeo|video|film/wideo|video|video|видео|βίντεο
nuevo|new|nouveau|neu|nuovo|novo|nou|nieuw|nowy|ny|yeni|новый|νέο
importante|important|important|wichtig|importante|importante|important|belangrijk|ważne|viktigt|önemli|важно|σημαντικό
ejemplo|example|exemple|Beispiel|esempio|exemplo|exemple|voorbeeld|przykład|exempel|örnek|пример|παράδειγμα
empresa|company|entreprise|Unternehmen|azienda|empresa|empresa|bedrijf|firma|företag|şirket|компания|εταιρεία
equipo|team|équipe|Team|squadra|equipe|equip|team|zespół|team|ekip|команда|ομάδα
precio|price|prix|Preis|prezzo|preço|preu|prijs|cena|pris|fiyat|цена|τιμή
tiempo|time|temps|Zeit|tempo|tempo|temps|tijd|czas|tid|zaman|время|χρόνος
año|year|an|Jahr|anno|ano|any|jaar|rok|år|yıl|год|χρόνος
día|day|jour|Tag|giorno|dia|dia|dag|dzień|dag|gün|день|ημέρα
con|with|avec|mit|con|com|amb|met|z|med|ile|с|με
para|for|pour|für|per|para|per a|voor|dla|för|için|для|για
muy|very|très|sehr|molto|muito|molt|zeer/heel|bardzo|mycket|çok|очень|πολύ
más|more|plus|mehr|più|mais|més|meer|więcej|mer|daha|больше|περισσότερο
gracias por tu atención|thank you for your attention|merci de votre attention|vielen Dank für Ihre Aufmerksamkeit|grazie per l'attenzione|obrigado pela atenção|gràcies per la teva atenció|bedankt voor je aandacht|dziękujemy za uwagę|tack för din uppmärksamhet|ilginiz için teşekkürler|спасибо за внимание|ευχαριστούμε για την προσοχή σας
`;

export interface GlossaryEntry {
  /** Target text per language (first alternative of the cell). */
  target: Partial<Record<LanguageCode, string>>;
}

type Index = Record<LanguageCode, Map<string, GlossaryEntry>>;

interface Glossary {
  /** Accent-sensitive keys: "sí" (yes) and "si" (if) are different words. */
  exact: Index;
  /** Accent-free keys, for text typed without accents. First meaning wins. */
  folded: Index;
  /** Longest phrase, in words, per source language. */
  maxWords: Record<LanguageCode, number>;
}

/** Lowercase key that keeps accents. */
function exactKey(text: string): string {
  return text.toLowerCase().normalize('NFC').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Lowercase, accent-free key. */
function foldedKey(text: string): string {
  return exactKey(text)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
}

function addTable(glossary: Glossary, table: string, columns: LanguageCode[]): void {
  const head = columns[0]!;
  for (const line of table.split('\n')) {
    if (line.trim() === '') continue;
    const cells = line.split('|').map((cell) =>
      cell
        .split('/')
        .map((alt) => alt.trim())
        .filter((alt) => alt !== ''),
    );
    // A row whose head word already exists completes that meaning with more languages
    // (the 13-language core extends rows of the 6-language table).
    const headWord = cells[0]?.[0];
    const entry: GlossaryEntry = (headWord
      ? glossary.exact[head].get(exactKey(headWord))
      : undefined) ?? { target: {} };
    for (const [column, language] of columns.entries()) {
      const alternatives = cells[column] ?? [];
      if (alternatives[0] !== undefined) entry.target[language] ??= alternatives[0];
      for (const alternative of alternatives) {
        const exact = exactKey(alternative);
        const folded = foldedKey(alternative);
        if (!glossary.exact[language].has(exact)) glossary.exact[language].set(exact, entry);
        if (!glossary.folded[language].has(folded)) glossary.folded[language].set(folded, entry);
        glossary.maxWords[language] = Math.max(
          glossary.maxWords[language],
          exact.split(' ').length,
        );
      }
    }
  }
}

function build(): Glossary {
  const perLanguage = <T>(make: () => T) =>
    Object.fromEntries(CORE_COLUMNS.map((language) => [language, make()])) as Record<
      LanguageCode,
      T
    >;
  const glossary: Glossary = {
    exact: perLanguage(() => new Map<string, GlossaryEntry>()),
    folded: perLanguage(() => new Map<string, GlossaryEntry>()),
    maxWords: perLanguage(() => 1),
  };
  addTable(glossary, MAIN, MAIN_COLUMNS);
  addTable(glossary, CORE, CORE_COLUMNS);
  return glossary;
}

const GLOSSARY: Glossary = build();

/** Longest glossary phrase of a language, in words. */
export function glossaryMaxWords(language: LanguageCode): number {
  return GLOSSARY.maxWords[language];
}

/** Number of distinct source phrases known for a language (documentation and tests). */
export function glossarySize(language: LanguageCode): number {
  return GLOSSARY.exact[language].size;
}

/** Find a phrase as written; failing that, without its accents. */
export function lookupGlossary(language: LanguageCode, phrase: string): GlossaryEntry | undefined {
  return (
    GLOSSARY.exact[language].get(exactKey(phrase)) ??
    GLOSSARY.folded[language].get(foldedKey(phrase))
  );
}
