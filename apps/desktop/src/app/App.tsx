import { RouterProvider } from 'react-router';
import { router } from './routes';
import { Toaster } from './components/Toaster';

export default function App() {
  return (
    <div className="size-full overflow-hidden font-body-family">
      <RouterProvider router={router} />
      <Toaster />
    </div>
  );
}