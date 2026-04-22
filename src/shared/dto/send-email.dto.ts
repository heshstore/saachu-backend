import { IsEmail, IsNotEmpty } from 'class-validator';

export class SendEmailDto {
  @IsEmail({}, { message: 'Invalid email address' })
  @IsNotEmpty()
  to: string;
}
