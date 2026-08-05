import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class ResolveEscalationDto {
  @IsIn(['mark_resolved', 'compose_send']) actionType!: 'mark_resolved' | 'compose_send';
  @IsString() @MinLength(1) actionTaken!: string;
  @IsOptional() @IsString() followupBody?: string;
  @IsIn(['closed_won', 're_engaged', 'no_response', 'churned', 'closed_no_action'])
  outcomeTag!: 'closed_won' | 're_engaged' | 'no_response' | 'churned' | 'closed_no_action';
}
