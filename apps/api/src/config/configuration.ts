export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? 'smartorder_verify_2025',
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v22.0',
    flowId: process.env.WHATSAPP_FLOW_ID ?? '',
    flowPrivateKey: process.env.FLOW_PRIVATE_KEY_BASE64
      ? Buffer.from(process.env.FLOW_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
      : (process.env.FLOW_PRIVATE_KEY ?? ''),
  },
  google: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
  },
  seller: {
    phoneNumber: process.env.SELLER_PHONE_NUMBER ?? '',
  },
});
