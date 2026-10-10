// UI strings for Track D modules, in the user's language. Lookup order: src/i18n (Track A's
// reviewed build-time translations), then Track D's drafts in ./translations.ts (to be reviewed
// by Track A), then English. The current UI language follows Prefs.lang (setUiLang).
import { t } from '../i18n';
import { DRAFTS } from './translations';

const FALLBACK = {
  'overlay.title': 'Shopping assistant',
  'overlay.close': 'Close shopping assistant',
  'render.pro': 'Pro',
  'render.con': 'Con',
  'render.warning': 'Warning',
  'render.warnings': 'Warnings',
  'render.suggestions': 'Suggestions',
  'render.simpler': 'Explain simpler',
  'zone.search': 'Search',
  'zone.results': 'Results',
  'zone.product': 'Product',
  'zone.cart': 'Cart',
  'zone.checkout': 'Checkout',
  'zone.orders': 'Orders',
  'zone.help': 'Help',
  'scan.title': 'Switch scanning',
  'scan.back': 'Back',
  'scan.choose': 'Choose',
  'scan.stop': 'Stop scanning',
  'scan.paused': 'Scanning paused. Press your switch to continue.',
  'phrases.title': 'Phrases',
  'phrases.more': 'More phrases',
  'phrase.read_page': 'Read this page',
  'phrase.price': "What's the price?",
  'phrase.reviews': 'What do reviews say?',
  'phrase.specs': 'Tell me the specs',
  'phrase.add_to_cart': 'Add to cart',
  'phrase.read_results': 'Read the results',
  'phrase.next_result': 'Next result',
  'phrase.go_to_cart': 'Go to my cart',
  'phrase.checkout': 'Checkout',
  'phrase.track_order': 'Track my order',
  'phrase.yes': 'Yes',
  'phrase.no': 'No',
  'phrase.repeat': 'Repeat that',
  'phrase.help': 'Help',
  'mode.visual': 'Read-aloud mode',
  'mode.motor': 'Easy-press mode',
  'mode.speech': 'Speech help mode',
  'mode.ageing': 'Simple mode',
  'mode.visual.desc': 'Reads pages and answers aloud, and speaks each choice.',
  'mode.motor.desc': 'Voice control, bigger buttons and single-switch scanning.',
  'mode.speech.desc': 'Listens patiently and offers phrase buttons.',
  'mode.ageing.desc': 'Larger text, slower speech and fewer choices at a time.',
  'suggest.title': 'Suggestion',
  'suggest.offer':
    '{mode} might make this easier. Turning it on in {seconds} seconds. Say no or press Escape to cancel.',
  'suggest.seconds': '{seconds} seconds',
  'suggest.countdown': 'Turning on in {seconds} s',
  'suggest.on': '{mode} is on. Say undo or press Undo to turn it off.',
  'suggest.on_title': '{mode} is on',
  'suggest.undone': '{mode} is off.',
  'suggest.cancelled': "OK, I won't suggest that again.",
  'suggest.accept': 'Turn on now',
  'suggest.decline': 'No thanks',
  'suggest.undo': 'Undo',
  'suggest.dismiss': 'OK',
  'suggest.question': 'Would you like me to read things aloud, or make buttons easier to press?',
  'suggest.answer_visual': 'Read things aloud',
  'suggest.answer_motor': 'Easier to press',
  'suggest.answer_neither': 'Neither',
  'overlay.badge': 'suggestion',
  'debug.title': 'Inference scores',
  'debug.condition': 'Condition',
  'debug.score': 'Score',
  'debug.signals': 'Signal groups',
  'debug.status': 'Status',
  'confirm.title': 'Please confirm',
  'confirm.yes': 'Yes',
  'confirm.no': 'No',
  'confirm.quantity': 'Quantity',
  'confirm.total': 'Total',
  'confirm.pin_code': 'Delivery PIN code',
  'confirm.go_ahead': 'Shall I go ahead?',
  'confirm.cancelled': 'Cancelled. Nothing was changed.',
  'confirm.nothing': 'There is nothing to confirm right now.',
  'action.done': 'Done.',
  'action.failed': "That didn't work on this page. You can try again or choose something else.",
  'action.not_found':
    "I couldn't find that button on the page any more. The page may have changed.",
  'action.disabled': "That button can't be pressed right now.",
  'action.secure_zone':
    "I can't do that inside a payment or password field. Please do that step yourself.",
  'action.not_seen':
    "I pressed it, but I couldn't see the page change. Please check before going on.",
  'turn.working': 'One moment.',
  'turn.failed': "Sorry, I couldn't get an answer just now. Please try again in a moment.",
  'mic.speak': 'Speak',
  'mic.stop': 'Stop listening',
  'mic.not_understood': "Sorry, I didn't catch that. Please try again.",
  'phrases.offer': 'Here are some phrases you can choose instead.',
  'onboarding.title': 'Welcome',
  'onboarding.language': 'Language · भाषा · భాష',
  // Track A's keys (src/i18n has reviewed hi/te text and recordings for these).
  'onboarding.choose_language': 'For English, say English or press 1.',
  'onboarding.read_aloud': 'Would you like me to read things aloud?',
  'onboarding.colours': 'Do colours ever look alike to you?',
  'onboarding.how':
    'Press a number, tap a choice, say your answer, or press Space to step through the choices with one switch.',
  'onboarding.yes': 'Yes',
  'onboarding.no': 'No',
  'onboarding.done':
    'All set. You can change these any time in Settings, inside the Shopping assistant.',
  'onboarding.finish': 'Finish',
  'onboarding.skip': 'Skip setup',
  'onboarding.not_understood': "Sorry, I didn't catch that. You can press a number instead.",
  'settings.title': 'Settings',
  'settings.modes': 'Modes',
  'settings.language': 'Language',
  'settings.colour': 'Colour names on swatches',
  'settings.scan': 'Start switch scanning',
  'settings.setup': 'Run setup again',
  'settings.saved': '{setting} turned {state}.',
  'settings.on': 'on',
  'settings.off': 'off',
  'speed.title': 'Speech speed',
  'speed.slower': 'Slower',
  'speed.faster': 'Faster',
  'speed.now': 'Speech speed {rate}',
  'repeat.nothing': 'There is nothing to repeat yet.',
  'help.summary': 'You can press a phrase button, or say things like these.',
  'help.heading': 'Things you can say',
  'render.back': 'Back to menu',
  'render.read_aloud': 'Read aloud',
  'render.stop_reading': 'Stop reading',
  'overlay.opened':
    'Shopping assistant open. Press Tab to move through it. Press Alt+Shift+A to close it.',
  'mic.demo':
    "Voice input needs the language service, which isn't connected in demo mode. Please use the buttons instead.",
  'settings.voice': 'Assistant speaks out loud',
  'settings.voice_hint': 'Turn this off if you use a screen reader.',
  'settings.text_size': 'Text size',
  'settings.smaller': 'Smaller',
  'settings.larger': 'Larger',
  'settings.short': 'Short answers',
  'settings.switch_key': 'Switch key: {key}',
  'settings.set_switch': 'Change switch key',
  'settings.press_key': 'Press the key you want to use as your switch.',
  'settings.by_you': '(you turned this on)',
  'settings.by_suggestion': '(turned on automatically; you can turn it off)',
  'settings.current':
    'Right now: {options} choices at a time, speech {rate}, scanning every {scan} seconds.',
  'onboarding.purpose.en':
    'Setting up the Shopping assistant: three quick questions so it suits you. You can change everything later in Settings.',
  'onboarding.purpose.hi':
    'शॉपिंग सहायक की सेटअप: तीन छोटे सवाल, ताकि यह आपके हिसाब से काम करे। बाद में सब कुछ सेटिंग्स में बदल सकते हैं।',
  'onboarding.purpose.te':
    'షాపింగ్ సహాయకుడి సెటప్: మీకు తగినట్లు పని చేయడానికి మూడు చిన్న ప్రశ్నలు. తర్వాత అన్నీ సెట్టింగ్‌లలో మార్చవచ్చు.',
  'menu.title': 'Actions on this page',
  'menu.toggle': 'Actions on this page ({count})',
  'menu.more': 'Show {count} more',
  'simple.open': 'Simple view',
  'simple.no_title': "The page doesn't list the product name",
  'simple.missing': "{field}: the page doesn't list this.",
  'simple.not_listed': "The page doesn't list this.",
  'simple.price': 'Price',
  'simple.mrp': 'Full price (MRP)',
  'simple.save': 'you save {amount}',
  'simple.rating': 'Rating',
  'simple.rating_value': '{value} out of 5 from {count} ratings',
  'simple.availability': 'Availability',
  'simple.delivery': 'Delivery',
  'simple.seller': 'Seller',
  'simple.specs': 'Key details',
  'simple.options': 'Options',
  'simple.selected': '(selected)',
  'simple.actions': 'What you can do',
  'help.examples':
    "What's the price? | What do reviews say? | Add to cart | Slower or faster | Repeat that | Yes or no",
} as const;

export type UiKey = keyof typeof FALLBACK;

let uiLang = 'en';

/** Set the language for UI strings (the app calls this from Prefs.lang). */
export function setUiLang(lang: string): void {
  uiLang = lang;
}

export function getUiLang(): string {
  return uiLang;
}

export function label(key: UiKey, lang: string = uiLang): string {
  const reviewed = t(key, lang);
  if (reviewed !== key && (lang === 'en' || reviewed !== t(key, 'en'))) return reviewed;
  return DRAFTS[lang]?.[key] ?? FALLBACK[key];
}
