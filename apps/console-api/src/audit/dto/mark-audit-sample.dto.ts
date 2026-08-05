import { IsIn } from 'class-validator';

export class MarkAuditSampleDto {
  @IsIn(['fine', 'concerning']) verdict!: 'fine' | 'concerning';
}
