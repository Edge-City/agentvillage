/**
 * SEED-REVISION round 3 (OV-302 refute M1/S2; lead 22:24Z): the CLOSED
 * VOCABULARY of Index's recovery question. question-guard.ts withholds a
 * question holding any word that is not in QUESTION_VOCAB (reason `vocab`),
 * after the allow-shape and before the denylist. A withheld question costs
 * nothing: the agent asks the fixed "What would make it clearer?" instead.
 *
 * The list is the words a short question about the resident's OWN intent
 * needs: question words, auxiliaries and pronouns, connectives, intent verbs
 * and nouns (who, what outcome, by when), and the words Index's recorded
 * recovery questions use (Carter's row 153 probes; question-vocab.test.ts
 * pins them). Nothing here names a secret, a payment, a channel, a contact,
 * a place, a date, a tool, a publish step or a consent word: VOCAB_NEVER
 * lists those, and the test fails if the two lists meet, or if any word of
 * VOCAB_NEVER, any stop word or any tool name can be spelled by joining
 * words of this list ("s can" would be `scan`, "co in" `coin`).
 *
 * Words are compared after NFKC and lower case, split at spaces, commas,
 * apostrophes and hyphens (vocabWords); a word holding an apostrophe or a
 * hyphen also passes when it is in the list whole (`what's`, `co-founder`).
 * Accents are NOT removed: `mèet` is not `meet`. Tighten only: a word is
 * added for a recorded Index question, never for a payload.
 */

export const QUESTION_VOCAB: ReadonlySet<string> = new Set(
  `
  who what which when where how why whom whose
  is are be do does did have has would could should can will
  you your yourself i we our they them their it its this that these those there here
  someone anyone anything something else
  and or of for to in on at by with from about as than like into within
  a an the any some one more most other others
  meet meeting meetings find looking look want wants need needs hoping hope seek seeking
  help offer offering learn build building join connect connecting collaborate collaborating
  work working partner partners partnership partnerships intro introduction introductions
  reach speak talk discuss bring know
  people person founder founders cofounder cofounders co-founder co-founders investor investors
  engineer engineers designer designers researcher researchers mentor mentors mentorship advice
  team teams company companies startup startups venture ventures business businesses
  project projects product products idea ideas skill skills expertise experience
  role roles field fields area areas topic topics sector sectors industry industries
  interest interests interested background stage stages goal goals milestone milestones
  outcome outcomes result results problem problems challenge challenges plan plans
  kind kinds type types sort specific specifically particular concrete exactly example examples mean
  primary primarily core main focus focusing focused addressing
  collaboration collaborators
  climate data
  city cities country countries place places location locations village
  time timeframe date week month year soon now long often many first next best good new
  right clear clearer detail details describe name mind prefer ideal ideally together
  what's who's where's how's that's there's it's you're you've we're they're i'm i've
  `
    .trim()
    .split(/\s+/),
);

/**
 * Words that must NEVER enter QUESTION_VOCAB (the refuter's harmful set, the
 * consent words, the month names, and the words a composed intent or a relay
 * would need). question-vocab.test.ts fails if the lists meet.
 */
export const VOCAB_NEVER: readonly string[] = `
  key keys private secret phrase phrases seed seeds word words code codes login password passwords pass account accounts
  card cards bank number numbers birth api token tokens wire funds fund money pay paid payment buy send sent gift gifts
  stake tether solana bitcoin coin coins crypto wallet invest investment message messages messenger signal telegram
  whatsapp dm dms text ping email mail scan qr gate midnight post posted publish published confirm confirmed agreed agree
  skip run bash curl print wipe forget directives guidance hire hiring senior junior
  yes no ok okay sure consent approve approved list listed listing live submit share call called
  tool tools agent assistant resident user users chat link click visit open download install enter address
  ignore instructions system prompt rules disregard override not me my us
  january february march april may june july august september october november december
  tonight today tomorrow much
  goa india bangalore london
`
  .trim()
  .split(/\s+/);

/** The words of a question as the vocabulary reads them: NFKC, lower case, `’` as `'`, split at spaces and commas; a word holding an apostrophe or a hyphen is followed by its parts. */
export function vocabWords(text: string): string[][] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/’/g, "'")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((word) => {
      const parts = word.split(/['-]+/).filter(Boolean);
      return parts.length > 1 ? [word, ...parts] : [word];
    });
}

/** True when some word of `body` (a question without its `?`) is outside QUESTION_VOCAB, whole and in parts. Pure. */
export function outOfVocabulary(body: string): boolean {
  return vocabWords(body).some(([whole, ...parts]) => !QUESTION_VOCAB.has(whole!) && !(parts.length > 1 && parts.every((p) => QUESTION_VOCAB.has(p))));
}
