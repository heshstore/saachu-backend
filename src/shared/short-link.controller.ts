import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../auth/public.decorator';

/**
 * Short, WhatsApp-friendly redirect links for public documents — e.g.
 * /q/Quo-00009 instead of /quotations/public/Quo-00009/pdf. Kept as plain
 * 302s to the existing public routes so PDF generation stays in one place.
 */
@Controller()
export class ShortLinkController {
  @Public()
  @Get('q/:no')
  redirectQuotation(@Param('no') no: string, @Res() res: Response) {
    res.redirect(302, `/quotations/public/${encodeURIComponent(no)}/pdf`);
  }
}
