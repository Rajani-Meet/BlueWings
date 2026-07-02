import { Router } from 'express';
import { handleMessage } from '../controllers/message.controller';

const router = Router();

router.post('/', handleMessage);

export default router;
