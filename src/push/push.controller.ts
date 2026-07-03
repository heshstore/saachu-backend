import {
  Controller,
  Post,
  Delete,
  Body,
  Request,
  HttpCode,
} from '@nestjs/common';
import { PushService } from './push.service';

@Controller('push')
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Post('register')
  @HttpCode(204)
  register(
    @Request() req,
    @Body() body: { token: string; platform?: string },
  ): Promise<void> {
    return this.pushService.registerToken(
      req.user.id,
      body.token,
      body.platform ?? 'web',
    );
  }

  @Delete('token')
  @HttpCode(204)
  remove(@Request() req, @Body() body: { token: string }): Promise<void> {
    return this.pushService.removeToken(req.user.id, body.token);
  }
}
