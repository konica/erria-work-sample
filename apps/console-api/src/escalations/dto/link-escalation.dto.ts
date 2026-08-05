import { IsUUID } from 'class-validator';

export class LinkEscalationDto {
  @IsUUID() resolutionId!: string;
}
