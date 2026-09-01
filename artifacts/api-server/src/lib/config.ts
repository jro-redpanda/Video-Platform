function requiredConfig(key: "PRODUCT_NAME" | "VID_APP_DOMAIN") {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} environment variable is required`);
  return value;
}

export const runtimeConfig = Object.freeze({
  productName: requiredConfig("PRODUCT_NAME"),
  // MOCK: replaced at step 18
  appDomain: requiredConfig("VID_APP_DOMAIN"),
});