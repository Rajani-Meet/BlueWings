import { Router } from 'express';
import { handleWhatsAppWebhook, verifyWhatsAppWebhook } from '../adapters/whatsapp.adapter';

const router = Router();

router.get('/', verifyWhatsAppWebhook);
router.post('/', handleWhatsAppWebhook);

export default router;
