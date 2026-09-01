import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * Tiny i18n, no dependency.
 *
 * The English string is the key: `t("Sign in")` returns the Georgian when the
 * language is set to KA, and falls back to the English key itself otherwise (or
 * when a translation is missing). So English stays the default, and anything not
 * yet translated still renders — never a blank or a raw key.
 *
 * Interpolation uses `{name}` placeholders: `t("Hi {who}", { who })`.
 * Plurals go through `usePlural()` so English keeps "1 card / 2 cards" while
 * Georgian, which does not inflect the noun after a number, uses one form.
 */

export type Lang = "en" | "ka";

const STORAGE_KEY = "pergola.lang";

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "ka") return saved;
  } catch {
    // Private mode or blocked storage — fall through to the browser hint.
  }
  try {
    if (navigator.language?.toLowerCase().startsWith("ka")) return "ka";
  } catch {
    // No navigator (SSR-ish) — English it is.
  }
  return "en";
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void };
const I18nContext = createContext<Ctx>({ lang: "en", setLang: () => {} });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Not persisting is fine; the toggle still works for this session.
    }
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLang(): [Lang, (l: Lang) => void] {
  const { lang, setLang } = useContext(I18nContext);
  return [lang, setLang];
}

function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  let out = s;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** t("English", { param }) — Georgian when active, English otherwise. */
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const { lang } = useContext(I18nContext);
  return (key, params) => {
    const s = lang === "ka" ? ka[key] ?? key : key;
    return fill(s, params);
  };
}

/**
 * Plurals. English chooses one/many by count; Georgian uses the `many` template
 * (its noun does not change after a number). Both fill `{count}`.
 *   pl(n, "{count} card", "{count} cards")
 */
export function usePlural(): (count: number, one: string, many: string, params?: Record<string, string | number>) => string {
  const { lang } = useContext(I18nContext);
  return (count, one, many, params) => {
    const merged = { count, ...params };
    if (lang === "ka") return fill(ka[many] ?? many, merged);
    return fill(count === 1 ? one : many, merged);
  };
}

/** Locale for Intl date/number formatting: Georgian dates when KA is active. */
export function useDateLocale(): string | undefined {
  const { lang } = useContext(I18nContext);
  return lang === "ka" ? "ka-GE" : undefined;
}

/** The EN / KA switch. Two buttons, current one marked. */
export function LanguageToggle({ className }: { className?: string }) {
  const [lang, setLang] = useLang();
  return (
    <div className={`langtoggle${className ? ` ${className}` : ""}`} role="group" aria-label="Language">
      <button
        type="button"
        className={`langopt${lang === "en" ? " on" : ""}`}
        aria-pressed={lang === "en"}
        onClick={() => setLang("en")}
        title="English"
      >
        EN
      </button>
      <button
        type="button"
        className={`langopt${lang === "ka" ? " on" : ""}`}
        aria-pressed={lang === "ka"}
        onClick={() => setLang("ka")}
        title="ქართული"
      >
        ქარ
      </button>
    </div>
  );
}

/**
 * Georgian translations, keyed by the English source string.
 * Missing keys fall back to English, so this can grow over time safely.
 */
const ka: Record<string, string> = {
  // — shared —
  "Pergola": "Pergola",
  "Loading…": "იტვირთება…",
  "Working…": "მუშავდება…",
  "Email": "ელფოსტა",
  "Password": "პაროლი",
  "Name": "სახელი",
  "Role": "როლი",
  "At least 10 characters.": "მინიმუმ 10 სიმბოლო.",
  "How teammates will see you": "როგორ დაგინახავენ გუნდის წევრები",
  "Sign in": "შესვლა",
  "Sign out": "გასვლა",
  "Close": "დახურვა",
  "Please try again.": "გთხოვთ, სცადოთ თავიდან.",

  // — SignIn —
  "Sign in to your boards.": "შედით თქვენს დაფებზე.",
  "Create the first account on this instance.": "შექმენით პირველი ანგარიში ამ ინსტანციაზე.",
  "Create account": "ანგარიშის შექმნა",
  "Create an account instead": "სანაცვლოდ შექმენით ანგარიში",
  "I already have an account": "უკვე მაქვს ანგარიში",
  "That did not work. Check the details and try again.": "ვერ მოხერხდა. შეამოწმეთ მონაცემები და სცადეთ თავიდან.",
  "Could not reach the server. Is it running?": "სერვერთან დაკავშირება ვერ მოხერხდა. ის ჩართულია?",

  // — Join —
  "That invitation is no longer good": "ეს მოწვევა აღარ მოქმედებს",
  "It has expired or already been used. Ask whoever invited you for a fresh link.":
    "ვადა გაუვიდა ან უკვე გამოყენებულია. სთხოვეთ მომწვევს ახალი ბმული.",
  "Go to the sign-in page": "გადადით შესვლის გვერდზე",
  "Checking your invitation…": "მოწვევის შემოწმება…",
  "You have been invited to join as {role}.": "თქვენ მოწვეული ხართ, როგორც {role}.",
  "a member": "წევრი",
  "an admin": "ადმინი",
  "an owner": "მფლობელი",
  "an observer": "დამკვირვებელი",
  "Fixed by the invitation.": "დაფიქსირებულია მოწვევით.",
  "Join": "შეერთება",
  "That did not work. Try again.": "ვერ მოხერხდა. სცადეთ თავიდან.",

  // — PublicBoard —
  "Nothing at this link": "ამ ბმულზე არაფერია",
  "This board is private, or the link is wrong. Ask whoever shared it to publish it again.":
    "ეს დაფა პირადია, ან ბმული არასწორია. სთხოვეთ გამზიარებელს ხელახლა გამოაქვეყნოს.",
  "Go to Pergola": "გადადით Pergola-ზე",
  "Read only": "მხოლოდ წასაკითხად",

  // — App: topbar & workspace —
  "New board": "ახალი დაფა",
  "It starts with three lists and six labels, ready to rename.":
    "იწყება სამი სიით და ექვსი ჭდით, გადასარქმევად მზად.",
  "Board name": "დაფის სახელი",
  "Create board": "დაფის შექმნა",
  "Invite someone": "მოიწვიე ვინმე",
  "They need an account on this instance already.": "მათ უკვე უნდა ჰქონდეთ ანგარიში ამ ინსტანციაზე.",
  "Member — edits cards": "წევრი — არედაქტირებს ბარათებს",
  "Admin — edits the board itself": "ადმინი — არედაქტირებს თავად დაფას",
  "Observer — reads and comments": "დამკვირვებელი — კითხულობს და აკომენტარებს",
  "Send invite": "მოწვევის გაგზავნა",
  "Nobody here uses that address": "ამ მისამართს აქ არავინ იყენებს",
  "No account on this instance matches {email}. Ask them to sign up first, then invite them.":
    "ამ ინსტანციაზე {email}-ს ვერცერთი ანგარიში ვერ ემთხვევა. სთხოვეთ ჯერ დარეგისტრირდნენ, შემდეგ მოიწვიეთ.",
  "That invite did not go through": "მოწვევა ვერ გაიგზავნა",
  "That file is not JSON": "ეს ფაილი არ არის JSON",
  "Export your board from Trello with Menu → More → Print and export → Export as JSON, then pick the file it saves.":
    "დააექსპორტეთ დაფა Trello-დან: Menu → More → Print and export → Export as JSON, შემდეგ აირჩიეთ შენახული ფაილი.",
  "That import did not work": "იმპორტი ვერ მოხერხდა",
  "The file did not look like a Trello board export.": "ფაილი არ ჰგავდა Trello დაფის ექსპორტს.",
  "Imported “{title}”": "იმპორტირებულია „{title}“",
  "{cards} cards across {lists} lists, with {labels} labels, {checklists} checklists and {comments} comments.":
    "{cards} ბარათი {lists} სიაში, {labels} ჭდით, {checklists} ჩეკლისტითა და {comments} კომენტარით.",
  " {count} archived card went straight to the archive.": " {count} დაარქივებული ბარათი პირდაპირ არქივში გადავიდა.",
  " {count} archived cards went straight to the archive.": " {count} დაარქივებული ბარათი პირდაპირ არქივში გადავიდა.",
  " Not carried over: {skipped}.": " არ გადმოვიდა: {skipped}.",
  "Open board: {title}": "დაფის გახსნა: {title}",
  "Create a board": "დაფის შექმნა",
  "Import a board from Trello": "დაფის იმპორტი Trello-დან",
  "Duplicate this board": "ამ დაფის დუბლირება",
  "Export this board as JSON": "ამ დაფის ექსპორტი JSON-ად",
  "Invite someone to this board": "მოიწვიე ვინმე ამ დაფაზე",
  "Open the archive ({count})": "არქივის გახსნა ({count})",
  "Open board settings": "დაფის პარამეტრების გახსნა",
  "Manage people and access": "მართეთ ხალხი და წვდომა",
  "Undo the last change": "ბოლო ცვლილების გაუქმება",
  "That export did not work": "ექსპორტი ვერ მოხერხდა",
  "Duplicate “{title}”": "„{title}“-ის დუბლირება",
  "Lists, labels, WIP limits and custom fields always come across. Cards are optional — leave them behind to use this board as a template.":
    "სიები, ჭდეები, WIP ლიმიტები და მორგებული ველები ყოველთვის გადმოდის. ბარათები არასავალდებულოა — დატოვეთ ისინი, რომ დაფა შაბლონად გამოიყენოთ.",
  "New board name": "ახალი დაფის სახელი",
  "{title} copy": "{title} ასლი",
  "Cards": "ბარათები",
  "Structure only — no cards": "მხოლოდ სტრუქტურა — ბარათების გარეშე",
  "Copy the cards too": "ბარათებიც დააკოპირე",
  "Duplicate": "დუბლირება",
  "That copy did not work": "კოპირება ვერ მოხერხდა",
  "Import": "იმპორტი",
  "Import a Trello JSON export": "Trello JSON ექსპორტის იმპორტი",
  "Copy this board, with or without its cards": "დააკოპირე ეს დაფა, ბარათებით ან მათ გარეშე",
  "Export": "ექსპორტი",
  "Download this board as JSON": "ჩამოტვირთე დაფა JSON-ად",
  "Automation, webhooks, sharing and tokens": "ავტომატიზაცია, ვებჰუკები, გაზიარება და ტოკენები",
  "Settings": "პარამეტრები",
  "Invite": "მოწვევა",
  "Search and commands": "ძებნა და ბრძანებები",
  "Search": "ძებნა",
  "Undo (⌘Z)": "გაუქმება (⌘Z)",
  "Undo": "გაუქმება",
  "{count} change saved here, waiting to sync": "{count} ცვლილება შენახულია აქ, სინქრონიზაციას ელოდება",
  "{count} changes saved here, waiting to sync": "{count} ცვლილება შენახულია აქ, სინქრონიზაციას ელოდება",
  "Live": "ცოცხალი",
  "Reconnecting": "ხელახლა დაკავშირება",
  "{count} pending": "{count} მოლოდინში",
  "Offline": "ოფლაინი",
  "People, invitations and who may join": "ხალხი, მოწვევები და ვინ შეიძლება შემოუერთდეს",
  "Admin": "ადმინი",
  "Nothing here yet": "აქ ჯერ არაფერია",
  "Make a board and it will come with three lists and six labels to start from.":
    "შექმენით დაფა და ის სამი სიითა და ექვსი ჭდით დაიწყება.",
  "Create the first board": "შექმენით პირველი დაფა",
  "Board": "დაფა",
  "Table": "ცხრილი",
  "Calendar": "კალენდარი",
  "Timeline": "ქრონოლოგია",
  "View": "ხედი",
  "Swimlanes": "ზოლები",
  "Off": "გამორთული",
  "By label": "ჭდის მიხედვით",
  "By member": "წევრის მიხედვით",
  "Loading board…": "დაფა იტვირთება…",

  // — Admin —
  "Member": "წევრი",
  "Owner": "მფლობელი",
  "Member — works on the boards they are added to": "წევრი — მუშაობს იმ დაფებზე, რომლებზეც დაამატეს",
  "Admin — that, and runs this instance": "ადმინი — ის, პლუს მართავს ამ ინსტანციას",
  "Owner — that, and cannot be locked out": "მფლობელი — ის, და ვერ დაიბლოკება",
  "Everyone and everything on this instance": "ყველა და ყველაფერი ამ ინსტანციაზე",
  "People": "ხალხი",
  "Invites": "მოწვევები",
  "Boards": "დაფები",
  "Access": "წვდომა",
  "Everyone here": "ყველა აქ",
  "These are instance roles, not board roles. An owner or an admin sees this console; a member only ever sees the boards they are on.":
    "ეს არის ინსტანციის როლები, არა დაფის როლები. მფლობელი ან ადმინი ხედავს ამ კონსოლს; წევრი მხოლოდ იმ დაფებს ხედავს, რომლებზეც არის.",
  "You cannot change your own role or deactivate yourself. Ask another owner.":
    "ვერ შეცვლით საკუთარ როლს ან ვერ დაიდეაქტივირებთ თავს. სთხოვეთ სხვა მფლობელს.",
  "you": "თქვენ",
  "Deactivated": "დეაქტივირებული",
  "{count} board": "{count} დაფა",
  "{count} boards": "{count} დაფა",
  "seen {ago} ago": "ნანახი {ago} წინ",
  "never signed in": "არასდროს შესულა",
  "Joined {date}": "შემოუერთდა {date}",
  "Instance role for {name}": "{name}-ის ინსტანციის როლი",
  "{name}'s role was not changed": "{name}-ის როლი არ შეიცვალა",
  "Deactivate": "დეაქტივაცია",
  "Activate": "აქტივაცია",
  "Deactivate {name}?": "დეაქტივირდეს {name}?",
  "It signs them out everywhere immediately and revokes every board they are on. Nothing they wrote is deleted, and activating them again gives all of it back.":
    "დაუყოვნებლივ გამოჰყავს ისინი ყველგან და უუქმებს ყველა დაფას, რომელზეც არიან. დაწერილი არაფერი იშლება და ხელახალი აქტივაცია ყველაფერს აბრუნებს.",
  "{name} was not activated": "{name} არ გააქტიურდა",
  "{name} was not deactivated": "{name} არ დეაქტივირდა",
  "This makes a one-time link. Nothing is emailed — a self-hosted box has no mail server — so you send it yourself.":
    "ეს ქმნის ერთჯერად ბმულს. არაფერი იგზავნება ელფოსტით — თვითჰოსტინგს არ აქვს ფოსტის სერვერი — ამიტომ თავად აგზავნით.",
  "Create invite": "მოწვევის შექმნა",
  "That invite was not created": "მოწვევა ვერ შეიქმნა",
  "Copy this link now": "დააკოპირეთ ეს ბმული ახლა",
  "{url}\n\nIt is shown once and cannot be shown again. Send it to {email} yourself — there is no email server on a fresh instance. It works for one sign-up and expires {when}.":
    "{url}\n\nის ერთხელ ჩანს და ხელახლა ვეღარ გამოჩნდება. გაუგზავნეთ {email}-ს თავად — ახალ ინსტანციაზე ფოსტის სერვერი არ არის. მუშაობს ერთი რეგისტრაციისთვის და ვადა იწურება {when}.",
  "That invite was not revoked": "მოწვევა ვერ გაუქმდა",
  "The sign-up rules were not changed": "რეგისტრაციის წესები არ შეიცვალა",
  "Could not read the people on this instance": "ამ ინსტანციის ხალხის წაკითხვა ვერ მოხერხდა",
  "Could not read the pending invites": "მოლოდინში მყოფი მოწვევების წაკითხვა ვერ მოხერხდა",
  "Could not read the boards": "დაფების წაკითხვა ვერ მოხერხდა",
  "Could not read the sign-up rules": "რეგისტრაციის წესების წაკითხვა ვერ მოხერხდა",
  "The server returned {status}.": "სერვერმა დააბრუნა {status}.",
  "Pending invites": "მოლოდინში მყოფი მოწვევები",
  "An invite is a one-time link, good for a single sign-up. Nothing is emailed, so copy the link when it appears and send it however you already talk to people.":
    "მოწვევა ერთჯერადი ბმულია, ერთი რეგისტრაციისთვის. არაფერი იგზავნება ელფოსტით, ამიტომ დააკოპირეთ ბმული, როცა გამოჩნდება, და გაუგზავნეთ ისე, როგორც ჩვეულებრივ ესაუბრებით ხალხს.",
  "Nobody is waiting to join.": "შესაერთებლად არავინ ელოდება.",
  "Expired": "ვადაგასული",
  "The link no longer works": "ბმული აღარ მუშაობს",
  "Expires {when}": "ვადა იწურება {when}",
  "invited by {name}": "მოიწვია {name}-მა",
  "Revoke": "გაუქმება",
  "Every board": "ყველა დაფა",
  "Every board on the instance, including the ones you are not a member of. Titles and counts only — this console does not open other people's cards.":
    "ინსტანციის ყველა დაფა, მათ შორის ის, რომლის წევრიც არ ხართ. მხოლოდ სათაურები და რაოდენობები — ეს კონსოლი სხვისი ბარათებს არ ხსნის.",
  "{count} of these {total} can be read by anyone with the link, without an account.":
    "ამ {total}-დან {count} ბმულის მქონე ნებისმიერს შეუძლია წაიკითხოს, ანგარიშის გარეშე.",
  "Nobody has made a board yet.": "დაფა ჯერ არავის შეუქმნია.",
  "Public": "საჯარო",
  "{count} member": "{count} წევრი",
  "{count} members": "{count} წევრი",
  "{count} card": "{count} ბარათი",
  "{count} cards": "{count} ბარათი",
  "started {date}": "დაიწყო {date}",
  "How people get in": "როგორ ხვდებიან ხალხი",
  "Sign-up": "რეგისტრაცია",
  "Anyone with the link can sign up": "ბმულის მქონე ნებისმიერს შეუძლია რეგისტრაცია",
  "Invite only (recommended)": "მხოლოდ მოწვევით (რეკომენდებული)",
  "Anyone with an email at an allowed domain": "ნებისმიერი, დაშვებული დომენის ელფოსტით",
  "An instance on the public internet with open sign-up will collect strangers.":
    "საჯარო ინტერნეტში ღია რეგისტრაციით ინსტანცია უცხოებს მოაგროვებს.",
  "Allowed domains": "დაშვებული დომენები",
  "Comma-separated, and only the part after the @.": "მძიმეებით გამოყოფილი, მხოლოდ @-ის შემდეგი ნაწილი.",
  "Save domains": "დომენების შენახვა",
  "No domains listed, so nobody can sign up at all.": "დომენები არ არის მითითებული, ამიტომ ვერავინ დარეგისტრირდება.",
  "Instance administration": "ინსტანციის ადმინისტრირება",
  "member": "წევრი",
  "admin": "ადმინი",
  "owner": "მფლობელი",
  "observer": "დამკვირვებელი",
  "Created {date}": "შეიქმნა {date}",
  "{count} off": "{count} გამორთ.",
  "moments": "წამები",
  "now": "ახლა",
  "in {count} minute": "{count} წუთში",
  "in {count} minutes": "{count} წუთში",
  "in {count} hour": "{count} საათში",
  "in {count} hours": "{count} საათში",
  "in {count} day": "{count} დღეში",
  "in {count} days": "{count} დღეში",

  // — Board / swimlanes / lists —
  "No label": "ჭდის გარეშე",
  "Unassigned": "მიუნიჭებელი",
  "this list": "ეს სია",
  "Delete “{name}”?": "წაიშალოს „{name}“?",
  "Its {count} cards go with it, and this cannot be undone. Archive the cards first if you might want them back.":
    "მისი {count} ბარათი მასთან ერთად წაიშლება და ეს შეუქცევადია. ჯერ დაარქივეთ ბარათები, თუ შესაძლოა დაგჭირდეთ.",
  "This cannot be undone.": "ეს შეუქცევადია.",
  "Delete list": "სიის წაშლა",
  "Add a list": "დაამატე სია",
  "List name": "სიის სახელი",
  "Add list": "სიის დამატება",

  // — Column —
  "Rename {title}": "{title}-ის გადარქმევა",
  "Double-click to rename": "ორმაგი დაწკაპუნება გადასარქმევად",
  "Set a work-in-progress limit": "დააყენე მიმდინარე სამუშაოს ლიმიტი (WIP)",
  "{count} of {limit} — click to change": "{count} / {limit} — დააწკაპუნეთ შესაცვლელად",
  "Work-in-progress limit": "მიმდინარე სამუშაოს ლიმიტი",
  "How many cards “{title}” should hold at once. The column turns red above it. Leave blank for no limit.":
    "რამდენი ბარათი უნდა ჰქონდეს „{title}“-ს ერთდროულად. ამის ზემოთ სვეტი წითლდება. ცარიელი დატოვეთ ლიმიტის გარეშე.",
  "Limit": "ლიმიტი",
  "No limit": "ლიმიტის გარეშე",
  "Set limit": "ლიმიტის დაყენება",
  "Delete list {title}": "სიის წაშლა: {title}",
  "Delete this list": "ამ სიის წაშლა",
  "Show {count} more": "აჩვენე კიდევ {count}",
  "{count} hidden": "{count} დამალული",
  "Add a card": "ბარათის დამატება",
  "What needs doing?": "რა უნდა გაკეთდეს?",
  "to add": "დასამატებლად",
  "to close": "დასახურად",

  // — Card —
  "Nothing has happened here in a while": "აქ დიდი ხანია არაფერი მომხდარა",
  "Checklist items": "ჩეკლისტის პუნქტები",
  "{count} vote(s)": "{count} ხმა",
  "Has a description": "აქვს აღწერა",

  // — FilterBar —
  "Any date": "ნებისმიერი თარიღი",
  "Overdue": "ვადაგადაცილებული",
  "Due soon": "მალე ვადა",
  "Has a date": "აქვს თარიღი",
  "No date": "თარიღის გარეშე",
  "Filter cards": "გაფილტრეთ ბარათები",
  "Filter cards by text": "ბარათების ფილტრი ტექსტით",
  "Filter by label": "ფილტრი ჭდით",
  "Filter by member": "ფილტრი წევრით",
  "Filter by due date": "ფილტრი ვადით",
  "{shown} of {total}": "{shown} / {total}",
  "Clear": "გასუფთავება",
  "Archive": "არქივი",

  // — CardDrawer —
  "in {list}": "{list}-ში",
  "Card title": "ბარათის სათაური",
  "Click to rename": "დააწკაპუნეთ გადასარქმევად",
  "Labels": "ჭდეები",
  "Members": "წევრები",
  "Dates": "თარიღები",
  "Cover": "გარეკანი",
  "One vote each": "თითო ხმა თითოეულს",
  "Vote": "ხმა",
  "Archiving can be undone with ⌘Z": "დაარქივება შეიძლება გაუქმდეს ⌘Z-ით",
  "Double-click a label's text to name it.": "ორმაგად დააწკაპუნეთ ჭდის ტექსტს დასასახელებლად.",
  "Starts": "იწყება",
  "Due": "ვადა",
  "Clear both dates": "ორივე თარიღის გასუფთავება",
  "Description": "აღწერა",
  "Add a more detailed description": "დაამატეთ უფრო დეტალური აღწერა",
  "Fields": "ველები",
  "Add a field": "ველის დამატება",
  "Fields belong to the board, and every card on it gets one.": "ველები დაფას ეკუთვნის და მისი ყველა ბარათი იღებს მას.",
  "Field name": "ველის სახელი",
  "Type": "ტიპი",
  "Text": "ტექსტი",
  "Number": "რიცხვი",
  "Date": "თარიღი",
  "Choice from a list": "არჩევანი სიიდან",
  "Checkbox": "მოსანიშნი",
  "Choices": "არჩევანები",
  "Comma separated. Only used by a choice field.": "მძიმეებით გამოყოფილი. მხოლოდ არჩევანის ველი იყენებს.",
  "Add field": "ველის დამატება",
  "Add": "დამატება",
  "None on this board yet.": "ამ დაფაზე ჯერ არცერთი.",
  "Delete the field “{name}”?": "წაიშალოს ველი „{name}“?",
  "It goes from every card on this board, and its values go with it.": "ის ქრება ამ დაფის ყველა ბარათიდან და მისი მნიშვნელობებიც მასთან ერთად.",
  "Delete field": "ველის წაშლა",
  "Delete field {name}": "ველის წაშლა: {name}",
  "Checklists": "ჩეკლისტები",
  "Add a checklist": "ჩეკლისტის დამატება",
  "Checklist name": "ჩეკლისტის სახელი",
  "Checklist": "ჩეკლისტი",
  "Add checklist": "ჩეკლისტის დამატება",
  "None yet.": "ჯერ არცერთი.",
  "Delete {name}": "წაშლა: {name}",
  "Its items go with it, and this cannot be undone.": "მისი პუნქტები მასთან ერთად ქრება და ეს შეუქცევადია.",
  "Delete checklist": "ჩეკლისტის წაშლა",
  "Item text": "პუნქტის ტექსტი",
  "Add an item": "პუნქტის დამატება",
  "Attachments": "დანართები",
  "That file was not accepted": "ეს ფაილი არ იქნა მიღებული",
  "Try a smaller file.": "სცადეთ უფრო პატარა ფაილი.",
  "Upload": "ატვირთვა",
  "Attach a link": "ბმულის მიმაგრება",
  "Or upload a file, if it lives on your machine.": "ან ატვირთეთ ფაილი, თუ ის თქვენს მოწყობილობაზეა.",
  "Label": "წარწერა",
  "What is it?": "რა არის ეს?",
  "Attach": "მიმაგრება",
  "Link": "ბმული",
  "None.": "არცერთი.",
  "Remove {name}": "წაშლა: {name}",
  "Activity": "აქტივობა",
  "Comments": "კომენტარები",
  "No comments yet.": "ჯერ კომენტარები არ არის.",
  "Someone": "ვიღაც",
  "edited": "რედაქტირებული",
  "Comment": "კომენტარი",
  "Delete comment": "კომენტარის წაშლა",
  "Write a comment": "დაწერეთ კომენტარი",
  "to post": "გამოსაქვეყნებლად",
  "Label name": "ჭდის სახელი",
  "just now": "ახლახ",
  "{count}m ago": "{count} წთ წინ",
  "{count}h ago": "{count} სთ წინ",

  // — Activity —
  "Nothing has happened yet.": "ჯერ არაფერი მომხდარა.",
  "via {name}": "{name}-ის მეშვეობით",

  // — Archive —
  "Archived cards": "დაარქივებული ბარათები",
  "Nothing has been archived.": "არაფერი დაარქივებულა.",
  "Restore": "აღდგენა",
  "Delete “{name}” for good?": "სამუდამოდ წაიშალოს „{name}“?",
  "Its comments and checklists go with it. This is the one action here that cannot be undone.":
    "მისი კომენტარები და ჩეკლისტები მასთან ერთად ქრება. ეს აქ ერთადერთი შეუქცევადი მოქმედებაა.",
  "Delete permanently": "სამუდამოდ წაშლა",
  "Delete": "წაშლა",

  // — TableView —
  "Card": "ბარათი",
  "Title": "სათაური",
  "List": "სია",
  "Who": "ვინ",
  "Done": "შესრულებული",
  "No cards match the current filter.": "მიმდინარე ფილტრს ბარათი არ ემთხვევა.",

  // — CalendarView —
  "Mon": "ორშ",
  "Tue": "სამ",
  "Wed": "ოთხ",
  "Thu": "ხუთ",
  "Fri": "პარ",
  "Sat": "შაბ",
  "Sun": "კვ",
  "Previous month": "წინა თვე",
  "Next month": "შემდეგი თვე",
  "Today": "დღეს",
  "{count} cards with a due date": "{count} ბარათი ვადით",

  // — Dialogs —
  "Confirm": "დადასტურება",
  "Save": "შენახვა",
  "Cancel": "გაუქმება",

  // — Palette (⌘K) —
  "Command palette": "ბრძანებების პალიტრა",
  "Search cards, or type a command": "მოძებნეთ ბარათები ან აკრიფეთ ბრძანება",
  "Search cards or run a command": "მოძებნეთ ბარათები ან გაუშვით ბრძანება",
  "Type at least two characters to search.": "ძებნისთვის აკრიფეთ მინიმუმ ორი სიმბოლო.",
  "Searching…": "იძებნება…",
  "Nothing matches “{q}”.": "„{q}“-ს არაფერი ემთხვევა.",
  "go": "გადი",
  "archived": "დაარქივებული",
  "move": "გადაადგილება",
  "open": "გახსნა",
  "close": "დახურვა",

  // — Notifications —
  "{count} unread notifications": "{count} წაუკითხავი შეტყობინება",
  "Notifications": "შეტყობინებები",
  "Inbox": "შემოსული",
  "Nothing yet.": "ჯერ არაფერია.",

  // — TimelineView —
  "Earlier": "უფრო ადრე",
  "Later": "უფრო გვიან",
  "{count} cards scheduled": "{count} დაგეგმილი ბარათი",
  "No card has a start or due date yet.": "ჯერ არცერთ ბარათს არ აქვს დაწყების ან ვადის თარიღი.",
  "due {date}": "ვადა {date}",
  "starts {date}": "იწყება {date}",

  // — Settings —
  "Board settings": "დაფის პარამეტრები",
  "Automation": "ავტომატიზაცია",
  "Webhooks": "ვებჰუკები",
  "Share": "გაზიარება",
  "Tokens": "ტოკენები",
  "Everything that has happened": "ყველაფერი, რაც მოხდა",
  "Read straight from the mutation log, so it cannot disagree with the board.":
    "წაკითხულია პირდაპირ მუტაციების ჟურნალიდან, ამიტომ დაფას ვერ დაუპირისპირდება.",
  "New rule": "ახალი წესი",
  "When something happens on this board, do something about it.":
    "როცა ამ დაფაზე რაღაც ხდება, მოახდინე რეაგირება.",
  "When": "როდის",
  "every checklist item is ticked": "ჩეკლისტის ყველა პუნქტი მონიშნულია",
  "a card is added": "ბარათი დაემატა",
  "a card moves": "ბარათი გადაინაცვლა",
  "a label is added": "ჭდე დაემატა",
  "Then": "შემდეგ",
  "move it to a list": "გადაიტანე სიაში",
  "archive it": "დააარქივე",
  "set a due date": "დააყენე ვადა",
  "post a comment": "დაწერე კომენტარი",
  "Used by “move to a list”.": "გამოიყენება „სიაში გადატანის“ მიერ.",
  "Create rule": "წესის შექმნა",
  "That rule was not accepted": "წესი არ იქნა მიღებული",
  "Check the fields and try again.": "შეამოწმეთ ველები და სცადეთ თავიდან.",
  "Rules": "წესები",
  "No rules yet. A rule watches for something happening and does something about it — the sort of thing Trello meters and calls Butler.":
    "ჯერ წესები არ არის. წესი აკვირდება რაღაცის მოხდენას და რეაგირებს — ისეთი, რასაც Trello ზომავს და Butler-ს უწოდებს.",
  "fired {count} times": "{count}-ჯერ გაეშვა",
  "On": "ჩართული",
  "Delete rule": "წესის წაშლა",
  "Add a webhook": "ვებჰუკის დამატება",
  "Every change on this board is POSTed here, signed so you can verify it.":
    "ამ დაფის ყოველი ცვლილება იგზავნება აქ POST-ით, ხელმოწერით, რომ გადაამოწმო.",
  "Endpoint URL": "ენდპოინტის URL",
  "Add webhook": "ვებჰუკის დამატება",
  "That endpoint was not accepted": "ეს ენდპოინტი არ იქნა მიღებული",
  "It needs to be a full URL.": "საჭიროა სრული URL.",
  "Copy the signing secret now": "დააკოპირეთ ხელმოწერის საიდუმლო ახლა",
  "{secret}\n\nIt is stored hashed and cannot be shown again. Verify deliveries with HMAC-SHA256 over \"timestamp.body\", using the x-pergola-timestamp and x-pergola-signature headers.":
    "{secret}\n\nინახება ჰეშირებულად და ხელახლა ვერ გამოჩნდება. გადაამოწმეთ მიწოდებები HMAC-SHA256-ით „timestamp.body“-ზე, x-pergola-timestamp და x-pergola-signature ჰედერების გამოყენებით.",
  "Endpoints": "ენდპოინტები",
  "Nothing subscribed. A webhook receives every change on this board as JSON, signed with its own secret.":
    "არაფერია გამოწერილი. ვებჰუკი იღებს ამ დაფის ყოველ ცვლილებას JSON-ად, თავისი საიდუმლოთი ხელმოწერილს.",
  "Last delivery failed: {error}": "ბოლო მიწოდება ჩაიშალა: {error}",
  "Last delivery OK ({status})": "ბოლო მიწოდება წარმატებულია ({status})",
  "Not fired yet": "ჯერ არ გაშვებულა",
  "Remove": "მოცილება",
  "Public link": "საჯარო ბმული",
  "A public board is readable by anyone with the link, without an account. Members and comment threads are never included — a visitor sees the work, not the people.":
    "საჯარო დაფას კითხულობს ბმულის მქონე ნებისმიერი, ანგარიშის გარეშე. წევრები და კომენტარები არასდროს შედის — სტუმარი ხედავს სამუშაოს, არა ხალხს.",
  "Anyone with the link": "ბმულის მქონე ნებისმიერი",
  "Members only": "მხოლოდ წევრები",
  "Make private": "გახადე პირადი",
  "Publish": "გამოქვეყნება",
  "Publish to generate the link, or leave the board private.":
    "გამოაქვეყნეთ ბმულის შესაქმნელად, ან დატოვეთ დაფა პირადი.",
  "New API token": "ახალი API ტოკენი",
  "Send it as an Authorization: Bearer header to use the whole API from a script.":
    "გააგზავნეთ როგორც Authorization: Bearer ჰედერი, რომ სკრიპტიდან მთელი API გამოიყენოთ.",
  "What is it for?": "რისთვის არის?",
  "Create token": "ტოკენის შექმნა",
  "Copy this token now": "დააკოპირეთ ეს ტოკენი ახლა",
  "{token}\n\nOnly its hash is stored, so this is the one time it can be shown.":
    "{token}\n\nინახება მხოლოდ მისი ჰეში, ამიტომ ეს ერთადერთი შემთხვევაა, როცა ის ჩანს.",
  "Your API tokens": "თქვენი API ტოკენები",
  "Tokens belong to you, not to a board, and reach every board you are a member of.":
    "ტოკენები თქვენ გეკუთვნით, არა დაფას, და წვდომა აქვთ ყველა დაფაზე, რომლის წევრიც ხართ.",
  "Last used {date}": "ბოლოს გამოყენებული {date}",
  "Never used": "არასდროს გამოყენებული",
};

export default ka;
