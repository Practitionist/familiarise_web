import { ThemeName } from './themes';

// Festival and occasion-based theme mapping
export const occasionThemes: Record<string, ThemeName> = {
  // Default (ShadCN style)
  default: 'blackSilver',
  
  // USA Festivals
  independence: 'fireRedOrange', // July 4th
  thanksgiving: 'fireRedOrange', // November
  halloween: 'fireRedOrange',    // October 31
  christmas: 'fireRedOrange',    // December 25
  newYear: 'purpleBlue',         // January 1
  
  // India Festivals
  diwali: 'fireRedOrange',       // October/November
  holi: 'purpleBlue',            // March
  independence_india: 'fireRedOrange', // August 15
  
  // General World Festivals
  valentine: 'fireRedOrange',    // February 14
  easter: 'blueTurquoise',       // March/April
  
  // Professional
  professional: 'blackSilver',
};

// Function to get theme based on current date or occasion
export const getOccasionTheme = (occasion?: string): ThemeName => {
  if (occasion && occasionThemes[occasion]) {
    return occasionThemes[occasion];
  }
  
  // Auto-detect based on date
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const day = now.getDate();
  
  // USA Festivals
  if (month === 7 && day === 4) return occasionThemes.independence;  // July 4th
  if (month === 10 && day === 31) return occasionThemes.halloween;    // Halloween
  if (month === 12 && day === 25) return occasionThemes.christmas;    // Christmas
  if (month === 1 && day === 1) return occasionThemes.newYear;        // New Year
  if (month === 11 && day >= 22 && day <= 28) return occasionThemes.thanksgiving; // Thanksgiving week
  
  // India Festivals (approximate dates)
  if (month === 8 && day === 15) return occasionThemes.independence_india; // Aug 15
  if (month === 10 || month === 11) return occasionThemes.diwali;      // Diwali season
  if (month === 3) return occasionThemes.holi;                         // Holi season
  
  // General World Festivals
  if (month === 2 && day === 14) return occasionThemes.valentine;      // Valentine's Day
  
  // Default theme (ShadCN style)
  return occasionThemes.default;
};

// Example usage:
// const theme = getOccasionTheme(); // Auto-detect based on date
// const theme = getOccasionTheme('diwali'); // Force specific festival
// const theme = getOccasionTheme('professional'); // Business theme