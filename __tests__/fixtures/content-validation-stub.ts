/** Stands in for utils/contentValidation, whose `bad-words` import is ESM-only under jest. */
export const hasDuplicates = () => false;
export const containsGibberish = () => false;
export const containsProfanity = () => false;
export const isProfanityFree = () => true;
export const isMeaningfulText = () => true;
export const validateSensibleContent = () => true;
export const cleanProfanity = (text: string) => text;
