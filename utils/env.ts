export const isDevelopmentEnvironment = (): boolean => {
  return process.env.NODE_ENV === "development";
};

export const isProductionEnvironment = (): boolean => {
  return process.env.NODE_ENV === "production";
};

export const isTestEnvironment = (): boolean => {
  return process.env.NODE_ENV === "test";
};

export const isDevelopmentOrTestEnvironment = (): boolean => {
  return isDevelopmentEnvironment() || isTestEnvironment();
};

export const isDevelopmentOrProductionEnvironment = (): boolean => {
  return isDevelopmentEnvironment() || isProductionEnvironment();
};

export const isProductionOrTestEnvironment = (): boolean => {
  return isProductionEnvironment() || isTestEnvironment();
};

export const isNotDevelopmentEnvironment = (): boolean => {
  return !isDevelopmentEnvironment();
};

export const isNotProductionEnvironment = (): boolean => {
  return !isProductionEnvironment();
};

export const isNotTestEnvironment = (): boolean => {
  return !isTestEnvironment();
};

export const isNotDevelopmentOrTestEnvironment = (): boolean => {
  return !isDevelopmentOrTestEnvironment();
};

export const isNotDevelopmentOrProductionEnvironment = (): boolean => {
  return !isDevelopmentOrProductionEnvironment();
};

export const isNotProductionOrTestEnvironment = (): boolean => {
  return !isProductionOrTestEnvironment();
};
