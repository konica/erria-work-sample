import { IsISO8601, IsString, MinLength, IsUUID } from 'class-validator';

export class InboundMessageDto {
  @IsUUID() accountId!: string;
  @IsString() @MinLength(1) body!: string;
  @IsISO8601() receivedAt!: string;
}
