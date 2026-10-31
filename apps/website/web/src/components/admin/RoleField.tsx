import { NativeSelect } from '@/components/ui/native-select';
import { ROLE_HINTS, ROLES, type Role } from '@/lib/admin/users';
import { Field } from './Field';

interface RoleFieldProps {
  id: string;
  value: Role;
  onChange: (role: Role) => void;
  errors: string[];
}

/** One role per account, with what it allows under the select. */
export function RoleField({ id, value, onChange, errors }: RoleFieldProps) {
  return (
    <Field id={id} label="Role" hint={ROLE_HINTS[value]} errors={errors} className="max-w-xs">
      {(control) => (
        <NativeSelect
          {...control}
          value={value}
          onChange={(event) => onChange(event.target.value as Role)}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}
