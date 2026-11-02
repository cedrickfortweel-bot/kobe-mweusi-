-- Make your email an admin
UPDATE profiles
SET role = 'admin'
WHERE email = 'your-email@example.com';

-- Example for an agent
UPDATE profiles
SET role = 'agent'
WHERE email = 'agent-email@example.com';

-- Example for a seller
UPDATE profiles
SET role = 'seller'
WHERE email = 'seller-email@example.com';

-- Example for a buyer
UPDATE profiles
SET role = 'buyer'
WHERE email = 'buyer-email@example.com';
