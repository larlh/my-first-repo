import type { LanguageCode } from '@parlante/shared';

/**
 * Fixed sentences of the local chat ("modo básico"). `{name}` = persona name, `{topics}` =
 * subjects found in the persona's knowledge. Kept short: they are spoken by the avatar.
 */
export interface ChatPhrases {
  greeting: string;
  thanks: string;
  bye: string;
  identity: string;
  howAreYou: string;
  /** The question matched nothing and the persona HAS knowledge. */
  noMatch: string;
  /** Appended to `noMatch` when the knowledge has recognisable subjects. */
  topics: string;
  /** The persona has no knowledge at all. */
  noKnowledge: string;
  /** Empty or unintelligible message. */
  empty: string;
}

export const CHAT_PHRASES: Record<LanguageCode, ChatPhrases> = {
  es: {
    greeting: 'Hola, soy {name}. ¿En qué puedo ayudarte?',
    thanks: '¡De nada! Si necesitas algo más, aquí estoy.',
    bye: '¡Hasta pronto! Gracias por la conversación.',
    identity: 'Soy {name}, un avatar virtual. Respondo con la información que me han preparado.',
    howAreYou: 'Muy bien, gracias. ¿En qué puedo ayudarte?',
    noMatch:
      'No tengo información sobre eso. Funciono en modo básico y solo puedo responder con lo que me han preparado.',
    topics: 'Puedo hablarte de: {topics}.',
    noKnowledge:
      'Funciono en modo básico y todavía no me han preparado información para responder preguntas.',
    empty: 'No te he entendido. ¿Puedes repetirlo con otras palabras?',
  },
  en: {
    greeting: 'Hello, I am {name}. How can I help you?',
    thanks: 'You are welcome! If you need anything else, I am here.',
    bye: 'See you soon! Thanks for the chat.',
    identity: 'I am {name}, a virtual avatar. I answer with the information I have been given.',
    howAreYou: 'Very well, thank you. How can I help you?',
    noMatch:
      'I do not have information about that. I run in basic mode and can only answer with what I have been given.',
    topics: 'I can tell you about: {topics}.',
    noKnowledge:
      'I run in basic mode and I have not been given any information to answer questions yet.',
    empty: 'I did not understand that. Could you say it in other words?',
  },
  fr: {
    greeting: 'Bonjour, je suis {name}. Comment puis-je vous aider ?',
    thanks: 'Avec plaisir ! Si vous avez besoin d’autre chose, je suis là.',
    bye: 'À bientôt ! Merci pour cette conversation.',
    identity:
      'Je suis {name}, un avatar virtuel. Je réponds avec les informations que l’on m’a fournies.',
    howAreYou: 'Très bien, merci. Comment puis-je vous aider ?',
    noMatch:
      'Je n’ai pas d’information à ce sujet. Je fonctionne en mode basique et je ne peux répondre qu’avec ce que l’on m’a fourni.',
    topics: 'Je peux vous parler de : {topics}.',
    noKnowledge:
      'Je fonctionne en mode basique et l’on ne m’a pas encore fourni d’informations pour répondre aux questions.',
    empty: 'Je n’ai pas compris. Pouvez-vous le dire autrement ?',
  },
  de: {
    greeting: 'Hallo, ich bin {name}. Wie kann ich Ihnen helfen?',
    thanks: 'Gern geschehen! Wenn Sie noch etwas brauchen, bin ich da.',
    bye: 'Bis bald! Danke für das Gespräch.',
    identity:
      'Ich bin {name}, ein virtueller Avatar. Ich antworte mit den Informationen, die ich erhalten habe.',
    howAreYou: 'Sehr gut, danke. Wie kann ich Ihnen helfen?',
    noMatch:
      'Dazu habe ich keine Informationen. Ich arbeite im Basismodus und kann nur mit dem antworten, was mir vorliegt.',
    topics: 'Ich kann Ihnen etwas sagen zu: {topics}.',
    noKnowledge:
      'Ich arbeite im Basismodus und habe noch keine Informationen erhalten, um Fragen zu beantworten.',
    empty: 'Das habe ich nicht verstanden. Können Sie es anders formulieren?',
  },
  it: {
    greeting: 'Ciao, sono {name}. Come posso aiutarti?',
    thanks: 'Prego! Se ti serve altro, sono qui.',
    bye: 'A presto! Grazie per la conversazione.',
    identity:
      'Sono {name}, un avatar virtuale. Rispondo con le informazioni che mi sono state fornite.',
    howAreYou: 'Molto bene, grazie. Come posso aiutarti?',
    noMatch:
      'Non ho informazioni su questo. Funziono in modalità base e posso rispondere solo con ciò che mi è stato fornito.',
    topics: 'Posso parlarti di: {topics}.',
    noKnowledge:
      'Funziono in modalità base e non mi sono ancora state fornite informazioni per rispondere alle domande.',
    empty: 'Non ho capito. Puoi ripeterlo con altre parole?',
  },
  pt: {
    greeting: 'Olá, eu sou {name}. Como posso ajudar?',
    thanks: 'De nada! Se precisar de mais alguma coisa, estou aqui.',
    bye: 'Até breve! Obrigado pela conversa.',
    identity:
      'Eu sou {name}, um avatar virtual. Respondo com as informações que me foram fornecidas.',
    howAreYou: 'Muito bem, obrigado. Como posso ajudar?',
    noMatch:
      'Não tenho informações sobre isso. Funciono em modo básico e só posso responder com o que me foi fornecido.',
    topics: 'Posso falar sobre: {topics}.',
    noKnowledge:
      'Funciono em modo básico e ainda não recebi informações para responder a perguntas.',
    empty: 'Não entendi. Pode repetir com outras palavras?',
  },
  ca: {
    greeting: 'Hola, soc {name}. En què et puc ajudar?',
    thanks: 'De res! Si necessites res més, soc aquí.',
    bye: 'Fins aviat! Gràcies per la conversa.',
    identity: 'Soc {name}, un avatar virtual. Responc amb la informació que m’han preparat.',
    howAreYou: 'Molt bé, gràcies. En què et puc ajudar?',
    noMatch:
      'No tinc informació sobre això. Funciono en mode bàsic i només puc respondre amb el que m’han preparat.',
    topics: 'Et puc parlar de: {topics}.',
    noKnowledge:
      'Funciono en mode bàsic i encara no m’han preparat informació per respondre preguntes.',
    empty: 'No t’he entès. Ho pots repetir amb altres paraules?',
  },
  nl: {
    greeting: 'Hallo, ik ben {name}. Waarmee kan ik je helpen?',
    thanks: 'Graag gedaan! Als je nog iets nodig hebt, ben ik er.',
    bye: 'Tot ziens! Bedankt voor het gesprek.',
    identity:
      'Ik ben {name}, een virtuele avatar. Ik antwoord met de informatie die ik heb gekregen.',
    howAreYou: 'Heel goed, dank je. Waarmee kan ik je helpen?',
    noMatch:
      'Daar heb ik geen informatie over. Ik werk in de basismodus en kan alleen antwoorden met wat ik heb gekregen.',
    topics: 'Ik kan je vertellen over: {topics}.',
    noKnowledge:
      'Ik werk in de basismodus en heb nog geen informatie gekregen om vragen te beantwoorden.',
    empty: 'Dat heb ik niet begrepen. Kun je het anders zeggen?',
  },
  pl: {
    greeting: 'Dzień dobry, jestem {name}. W czym mogę pomóc?',
    thanks: 'Proszę bardzo! Jeśli potrzebujesz czegoś jeszcze, jestem tutaj.',
    bye: 'Do zobaczenia! Dziękuję za rozmowę.',
    identity:
      'Jestem {name}, wirtualny awatar. Odpowiadam na podstawie przekazanych mi informacji.',
    howAreYou: 'Bardzo dobrze, dziękuję. W czym mogę pomóc?',
    noMatch:
      'Nie mam informacji na ten temat. Działam w trybie podstawowym i mogę odpowiadać tylko na podstawie tego, co mi przekazano.',
    topics: 'Mogę opowiedzieć o: {topics}.',
    noKnowledge:
      'Działam w trybie podstawowym i nie przekazano mi jeszcze informacji potrzebnych do odpowiadania na pytania.',
    empty: 'Nie zrozumiałem. Czy możesz powiedzieć to inaczej?',
  },
  sv: {
    greeting: 'Hej, jag är {name}. Hur kan jag hjälpa dig?',
    thanks: 'Varsågod! Om du behöver något mer finns jag här.',
    bye: 'Vi ses! Tack för samtalet.',
    identity: 'Jag är {name}, en virtuell avatar. Jag svarar med den information jag har fått.',
    howAreYou: 'Mycket bra, tack. Hur kan jag hjälpa dig?',
    noMatch:
      'Jag har ingen information om det. Jag körs i grundläge och kan bara svara med det jag har fått.',
    topics: 'Jag kan berätta om: {topics}.',
    noKnowledge:
      'Jag körs i grundläge och har ännu inte fått någon information för att kunna svara på frågor.',
    empty: 'Jag förstod inte. Kan du säga det på ett annat sätt?',
  },
  tr: {
    greeting: 'Merhaba, ben {name}. Size nasıl yardımcı olabilirim?',
    thanks: 'Rica ederim! Başka bir şeye ihtiyacınız olursa buradayım.',
    bye: 'Görüşmek üzere! Sohbet için teşekkürler.',
    identity: 'Ben {name}, sanal bir avatarım. Bana verilen bilgilerle yanıt veriyorum.',
    howAreYou: 'Çok iyiyim, teşekkürler. Size nasıl yardımcı olabilirim?',
    noMatch:
      'Bu konuda bilgim yok. Temel modda çalışıyorum ve yalnızca bana verilen bilgilerle yanıt verebilirim.',
    topics: 'Şu konularda bilgi verebilirim: {topics}.',
    noKnowledge: 'Temel modda çalışıyorum ve soruları yanıtlamam için henüz bana bilgi verilmedi.',
    empty: 'Anlayamadım. Başka sözcüklerle tekrar eder misiniz?',
  },
  ru: {
    greeting: 'Здравствуйте, меня зовут {name}. Чем могу помочь?',
    thanks: 'Пожалуйста! Если понадобится что-то ещё, я здесь.',
    bye: 'До скорой встречи! Спасибо за разговор.',
    identity:
      'Меня зовут {name}, я виртуальный аватар. Я отвечаю на основе информации, которую мне предоставили.',
    howAreYou: 'Очень хорошо, спасибо. Чем могу помочь?',
    noMatch:
      'У меня нет информации об этом. Я работаю в базовом режиме и могу отвечать только на основе того, что мне предоставили.',
    topics: 'Я могу рассказать о следующем: {topics}.',
    noKnowledge:
      'Я работаю в базовом режиме, и мне пока не предоставили информацию для ответов на вопросы.',
    empty: 'Я не понял. Можете сказать это другими словами?',
  },
  el: {
    greeting: 'Γεια σας, είμαι {name}. Πώς μπορώ να σας βοηθήσω;',
    thanks: 'Παρακαλώ! Αν χρειαστείτε κάτι άλλο, είμαι εδώ.',
    bye: 'Τα λέμε σύντομα! Ευχαριστώ για τη συζήτηση.',
    identity: 'Είμαι {name}, ένα εικονικό άβαταρ. Απαντώ με τις πληροφορίες που μου έχουν δοθεί.',
    howAreYou: 'Πολύ καλά, ευχαριστώ. Πώς μπορώ να σας βοηθήσω;',
    noMatch:
      'Δεν έχω πληροφορίες γι’ αυτό. Λειτουργώ σε βασική λειτουργία και μπορώ να απαντώ μόνο με όσα μου έχουν δοθεί.',
    topics: 'Μπορώ να σας μιλήσω για: {topics}.',
    noKnowledge:
      'Λειτουργώ σε βασική λειτουργία και δεν μου έχουν δοθεί ακόμη πληροφορίες για να απαντώ σε ερωτήσεις.',
    empty: 'Δεν κατάλαβα. Μπορείτε να το πείτε με άλλα λόγια;',
  },
};
