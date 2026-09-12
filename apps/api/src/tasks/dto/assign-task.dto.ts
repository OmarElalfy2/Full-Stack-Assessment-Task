import { IsMongoId, ValidateIf } from 'class-validator';

/**
 * Always expects an explicit intent: a project member's id to assign, or
 * `null` to unassign. There is no "omit the field" shorthand — this mirrors
 * `UpdateTaskStatusDto`, where the endpoint's one job is to set this one
 * value.
 */
export class AssignTaskDto {
  @ValidateIf((_dto: AssignTaskDto, value: unknown) => value !== null)
  @IsMongoId()
  assigneeId: string | null;
}
